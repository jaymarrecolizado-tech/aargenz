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
//   GROQ_API_KEY      – required for the "groq" provider
//   AI_PROVIDER       – "groq" (default) | "local"; clients may override per
//                       request by sending { provider } in the JSON body
//   LOCAL_BASE_URL    – e.g. http://localhost:11434/v1
//   LOCAL_MODEL       – model name served locally, e.g. qwen3:14b

const GROQ_MODEL = "llama-3.3-70b-versatile";
const UPSTREAM_TIMEOUT_MS = 180000;

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
    response_format: { type: "json_object" },
    stream: wantsStream || undefined, // omitted when false
    messages
  });

  let upstreamUrl, upstreamHeaders, upstreamBody;
  if (provider === "local") {
    const localModel = process.env.LOCAL_MODEL;
    if (!localModel) {
      return res.status(500).json({ error: { message: "LOCAL_MODEL is not set on the server" } });
    }
    upstreamUrl = (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "") + "/chat/completions";
    upstreamHeaders = { "Content-Type": "application/json" };
    upstreamBody = makeBody(localModel);
  } else {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: "GROQ_API_KEY is not set on the server" } });
    }
    upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
    upstreamHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
    upstreamBody = makeBody(GROQ_MODEL);
  }

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = wantsStream ? null : setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: upstreamBody,
      signal: ctrl.signal
    });

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
