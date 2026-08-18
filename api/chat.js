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
//   XAI_API_KEY / XAI_API_KEYS – optional xAI (Grok) keys: the automatic
//                       fallback provider used when every Groq key is
//                       rate-limited or rejected. XAI_MODEL sets the model
//                       (default grok-4.6).
//   AI_PROVIDER       – "groq" (default) | "local"; clients may override per
//                       request by sending { provider } in the JSON body
//   LOCAL_BASE_URL    – e.g. http://localhost:11434/v1
//   LOCAL_MODEL       – model name served locally, e.g. qwen3:14b

const GROQ_MODEL = "openai/gpt-oss-120b";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.6";
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 180000;

const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",").map(k => k.trim()).filter(Boolean);
const XAI_KEYS = (process.env.XAI_API_KEYS || process.env.XAI_API_KEY || "")
  .split(",").map(k => k.trim()).filter(Boolean);

// Index of the last key that worked; new requests start from it so a healthy
// key is preferred and exhausted keys are only hit when they're the only option.
let groqKeyCursor = 0;
let xaiKeyCursor = 0;

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

  // One candidate per key: the handler tries Groq keys first (each in turn,
  // moving on when a key is rate-limited / rejected) and falls through to the
  // xAI (Grok) key pool when EVERY Groq key fails. A single local candidate is
  // used for AI_PROVIDER=local.
  let groqCandidates = [];
  let xaiCandidates = [];
  if (provider === "local") {
    const localModel = process.env.LOCAL_MODEL;
    if (!localModel) {
      return res.status(500).json({ error: { message: "LOCAL_MODEL is not set on the server" } });
    }
    groqCandidates = [{
      url: (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "") + "/chat/completions",
      body: makeBody(localModel),
      headers: { "Content-Type": "application/json" },
      label: "local model"
    }];
  } else {
    if (!GROQ_KEYS.length && !XAI_KEYS.length) {
      return res.status(500).json({ error: { message: "GROQ_API_KEY / GROQ_API_KEYS (or XAI_API_KEY / XAI_API_KEYS) is not set on the server" } });
    }
    groqCandidates = GROQ_KEYS.map(key => ({
      url: "https://api.groq.com/openai/v1/chat/completions",
      body: makeBody(GROQ_MODEL),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      label: "Groq"
    }));
    xaiCandidates = XAI_KEYS.map(key => ({
      url: XAI_URL,
      body: makeBody(XAI_MODEL),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      label: "xAI"
    }));
  }

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = wantsStream ? null : setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let upRes = null;
    let lastErr = null;
    let lastKeyErr = null; // { status, text } of the last rate-limited/rejected key
    let allKeyIssues = true;

    // Phase 1: Groq keys (or the local model), starting from the last key that
    // worked. Phase 2: xAI (Grok) keys - only reached when every Groq key is
    // exhausted.
    const phases = provider === "local"
      ? [{ candidates: groqCandidates, cursor: () => 0, setCursor: () => {} }]
      : [
          { candidates: groqCandidates, cursor: () => groqKeyCursor, setCursor: (i) => { groqKeyCursor = i; } },
          { candidates: xaiCandidates, cursor: () => xaiKeyCursor, setCursor: (i) => { xaiKeyCursor = i; } }
        ];

    for (const phase of phases) {
      const list = phase.candidates;
      if (!list.length) continue;
      const start = phase.cursor() % list.length;
      for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const cand = list[idx];
        try {
          upRes = await fetch(cand.url, {
            method: "POST",
            headers: cand.headers,
            body: cand.body,
            signal: ctrl.signal
          });
        } catch (e) {
          lastErr = e;
          if (e.name === "AbortError") throw e; // client disconnected / timeout
          console.warn(`[api/chat] ${cand.label} candidate ${idx + 1}/${list.length} failed: ${e.message}`);
          continue;
        }
        // Key-related failures (rate limit / invalid key) → try the next key.
        const keyIssue = provider !== "local" && [401, 403, 429].includes(upRes.status);
        if (!upRes.ok && keyIssue) {
          const text = await upRes.text().catch(() => ""); // drain so the connection can be reused
          lastKeyErr = { status: upRes.status, text };
          console.warn(`[api/chat] ${cand.label} key ${idx + 1}/${list.length} returned ${upRes.status}; trying next key`);
          upRes = null;
          continue;
        }
        allKeyIssues = false;
        if (upRes.ok) phase.setCursor(idx); // remember the key that worked
        break; // success, or a non-key error to relay as-is
      }
      // Move to the next provider only if this phase was fully exhausted
      // (every key rate-limited/rejected or unreachable).
      if (upRes) break;
    }
    // Every key was rejected / rate-limited — advance both cursors so the next
    // request starts from a different key, then relay the last error.
    if (!upRes && allKeyIssues) {
      if (groqCandidates.length > 1) groqKeyCursor = (groqKeyCursor + 1) % groqCandidates.length;
      if (xaiCandidates.length > 1) xaiKeyCursor = (xaiKeyCursor + 1) % xaiCandidates.length;
    }
    if (!upRes && lastKeyErr) {
      res.writeHead(lastKeyErr.status, { "Content-Type": "application/json" });
      return res.end(lastKeyErr.text || JSON.stringify({ error: { message: "All API keys failed (last: " + lastKeyErr.status + ")" } }));
    }
    if (!upRes) throw lastErr || new Error("No upstream candidates");

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
