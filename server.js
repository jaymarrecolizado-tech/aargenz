// Local development server for the AAR Generator.
// Serves the static files AND proxies /api/chat to either a local model
// (Ollama / LM Studio / llama.cpp / vLLM) or Groq, so API keys stay server-side.
// Streaming (SSE) responses are piped through as-is when the client requests
// them with { stream: true }.
//
// Usage:
//   GROQ_API_KEY=your_key AI_PROVIDER=local node server.js
//   (AI_PROVIDER: "groq" (default) | "local"; keys fall back to config.js)
//
// Then open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || readKeyFromConfig();
const AI_PROVIDER = process.env.AI_PROVIDER || "groq"; // clients can override per-request via body.provider
const LOCAL_BASE_URL = (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const LOCAL_MODEL = process.env.LOCAL_MODEL || "qwen3:14b";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const UPSTREAM_TIMEOUT_MS = 180000;

function readKeyFromConfig() {
  try {
    const cfg = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const match = cfg.match(/GROQ_API_KEY\s*:\s*["']([^"']+)["']/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    }

    const provider = (body && body.provider) || AI_PROVIDER;
    const wantsStream = !!(body && body.stream);
    const messages = (body && body.messages) || [];
    const makeBody = (model) => JSON.stringify({
      model,
      max_tokens: (body && body.max_tokens) || 4000,
      temperature: 0.2,
      response_format: { type: "json_object" },
      stream: wantsStream || undefined, // omitted when false
      messages
    });

    let upstreamUrl, upstreamHeaders, upstreamBody;
    if (provider === "local") {
      if (!LOCAL_MODEL) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "LOCAL_MODEL is not set on the server" } }));
      }
      upstreamUrl = LOCAL_BASE_URL + "/chat/completions";
      upstreamHeaders = { "Content-Type": "application/json" };
      upstreamBody = makeBody(LOCAL_MODEL);
    } else {
      if (!GROQ_API_KEY) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "GROQ_API_KEY is not set (set it in the environment or config.js)" } }));
      }
      upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
      upstreamHeaders = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      };
      upstreamBody = makeBody(GROQ_MODEL);
    }

    // Abort the upstream request if the client disconnects; add a hard timeout
    // for buffered (non-streaming) requests only.
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
      return res.end(JSON.stringify({ error: { message: "Upstream request failed: " + (err.message || "unknown") } }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Static files
  let filePath = path.join(__dirname, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AAR Generator running at http://localhost:${PORT} (AI provider: ${AI_PROVIDER})`);
});
