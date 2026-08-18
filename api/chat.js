// Serverless proxy for the AAR Generator chat API.
// Routes /api/chat to either a local model (Ollama / LM Studio / llama.cpp /
// vLLM) or Groq, keeping API keys server-side. Streaming (SSE) responses are
// piped through when the client sends { stream: true }.
//
// Works on:
//   - Vercel: place in /api/chat.js  (function URL: /api/chat)
//   - Netlify: place in /netlify/functions/chat.js and adjust the route
//   - Any Node 18+ host with a compatible handler
//
// Env vars:
//   GROQ_API_KEY / GROQ_API_KEYS – required for the "groq" provider. A pool of
//                       keys (comma-separated) is supported: when the active
//                       key hits its rate limit (429) or is rejected (401/403)
//                       the request retries with the next key automatically.
//   AI_PROVIDER       – "groq" (default) | "local"; clients may override per
//                       request by sending { provider } in the JSON body
//   LOCAL_BASE_URL    – e.g. http://localhost:11434/v1
//   LOCAL_MODEL       – model name served locally, e.g. qwen3:14b

const GROQ_MODEL = "openai/gpt-oss-120b";
const UPSTREAM_TIMEOUT_MS = 180000;

const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",").map(k => k.trim()).filter(Boolean);

// Index of the last key that worked; new requests start from it so a healthy
// key is preferred and exhausted keys are only hit when they're the only option.
let groqKeyCursor = 0;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: { message: "Invalid JSON body" } });
  }

  const provider = body.provider || process.env.AI_PROVIDER || "groq";
  const wantsStream = !!body.stream;
  const messages = body.messages || [];
  const makeBody = (model) => JSON.stringify({
    model,
    max_tokens: body.max_tokens || 4000,
    temperature: 0.2,
    // No response_format: the assistant asks questions in prose first and
    // only emits the final JSON at the end (see SYSTEM_PROMPT in index.html).
    stream: wantsStream || undefined, // omitted when false
    messages
  });

  let upstreamUrl, upstreamBody;
  // One candidate per Groq key (or a single local candidate): the handler tries
  // each in turn and only moves on when a key is rate-limited / rejected.
  let candidates;
  if (provider === "local") {
    const localModel = process.env.LOCAL_MODEL;
    if (!localModel) {
      return res.status(500).json({ error: { message: "LOCAL_MODEL is not set on the server" } });
    }
    upstreamUrl = (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "") + "/chat/completions";
    upstreamBody = makeBody(localModel);
    candidates = [{ headers: { "Content-Type": "application/json" } }];
  } else {
    if (!GROQ_KEYS.length) {
      return res.status(500).json({ error: { message: "GROQ_API_KEY / GROQ_API_KEYS is not set on the server" } });
    }
    upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
    upstreamBody = makeBody(GROQ_MODEL);
    candidates = GROQ_KEYS.map(key => ({
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` }
    }));
  }

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = wantsStream ? null : setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let upRes = null;
    let lastErr = null;
    let lastKeyErr = null; // { status, text } of the last rate-limited/rejected key
    const start = groqKeyCursor % candidates.length;
    let successIdx = -1;
    let allKeyIssues = true;
    for (let i = 0; i < candidates.length; i++) {
      const idx = (start + i) % candidates.length;
      try {
        upRes = await fetch(upstreamUrl, {
          method: "POST",
          headers: candidates[idx].headers,
          body: upstreamBody,
          signal: ctrl.signal
        });
      } catch (e) {
        lastErr = e;
        if (e.name === "AbortError") throw e; // client disconnected / timeout
        console.warn(`[api/chat] request via candidate ${idx + 1}/${candidates.length} failed: ${e.message}`);
        continue;
      }
      // Key-related failures (rate limit / invalid key) → try the next key.
      const keyIssue = provider !== "local" && [401, 403, 429].includes(upRes.status);
      if (!upRes.ok && keyIssue) {
        const text = await upRes.text().catch(() => ""); // drain so the connection can be reused
        lastKeyErr = { status: upRes.status, text };
        console.warn(`[api/chat] Groq key ${idx + 1}/${candidates.length} returned ${upRes.status}; trying next key`);
        upRes = null;
        continue;
      }
      allKeyIssues = false;
      if (upRes.ok) successIdx = idx; // remember the key that worked
      break;
    }
    // Every key was rejected / rate-limited — relay the last key's error.
    if (!upRes && lastKeyErr) {
      res.writeHead(lastKeyErr.status, { "Content-Type": "application/json" });
      return res.end(lastKeyErr.text || JSON.stringify({ error: { message: "All Groq API keys failed (last: " + lastKeyErr.status + ")" } }));
    }
    if (!upRes) throw lastErr || new Error("No upstream candidates");
    if (successIdx >= 0) {
      groqKeyCursor = successIdx; // prefer the key that just worked
    } else if (allKeyIssues && candidates.length > 1) {
      groqKeyCursor = (groqKeyCursor + 1) % candidates.length; // all limited — start elsewhere next time
    }

    if (wantsStream && upRes.body) {
      res.writeHead(upRes.status, {
        "Content-Type": upRes.headers.get("content-type") || "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      for await (const chunk of upRes.body) res.write(chunk);
      return res.end();
    }

    const data = await upRes.json();
    res.writeHead(upRes.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(data));
  } catch (err) {
    if (res.writableEnded) return;
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Upstream request failed: " + (err.message || "unknown error") } }));
  } finally {
    if (timer) clearTimeout(timer);
  }
};
