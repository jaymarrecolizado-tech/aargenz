// Local development server for the AAR Generator.
// Serves the static files AND proxies /api/chat to either a local model
// (Ollama / LM Studio / llama.cpp / vLLM) or Groq, so API keys stay server-side.
// Streaming (SSE) responses are piped through as-is when the client requests
// them with { stream: true }.
//
// Usage:
//   GROQ_API_KEY=your_key AI_PROVIDER=local node server.js
//   GROQ_API_KEYS=key1,key2 node server.js   (pool: auto-rotate on 429/401/403)
//   (AI_PROVIDER: "groq" (default) | "local"; keys fall back to config.js)
//
// Then open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
// Shared pool of Groq API keys. Accepts GROQ_API_KEYS="k1,k2" (env), a single
// GROQ_API_KEY (env), or both from config.js. When the active key hits its rate
// limit (HTTP 429) or is rejected (401/403), the request is retried with the
// next key in the pool.
const GROQ_KEYS = readGroqKeys();
const AI_PROVIDER = process.env.AI_PROVIDER || "groq"; // clients can override per-request via body.provider
const LOCAL_BASE_URL = (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const LOCAL_MODEL = process.env.LOCAL_MODEL || "qwen3:14b";
const GROQ_MODEL = "openai/gpt-oss-120b";
const UPSTREAM_TIMEOUT_MS = 180000;

// Index of the last key that worked; new requests start from it so a healthy
// key is preferred and exhausted keys are only hit when they're the only option.
let groqKeyCursor = 0;

function readGroqKeys() {
  const fromEnv = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
    .split(",").map(k => k.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const cfg = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const arr = cfg.match(/GROQ_API_KEYS\s*:\s*\[([^\]]*)\]/);
    if (arr) {
      const keys = (arr[1].match(/["'][^"']+["']/g) || [])
        .map(k => k.replace(/["']/g, "").trim()).filter(Boolean);
      if (keys.length) return keys;
    }
    const single = cfg.match(/GROQ_API_KEY\s*:\s*["']([^"']+)["']/);
    return single ? [single[1]] : [];
  } catch {
    return [];
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
      // No response_format: the assistant asks questions in prose first and
      // only emits the final JSON at the end (see SYSTEM_PROMPT in index.html).
      stream: wantsStream || undefined, // omitted when false
      messages
    });

    let upstreamUrl, upstreamBody;
    // One candidate per Groq key (or a single local candidate): the proxy tries
    // each in turn and only moves on when a key is rate-limited / rejected.
    let candidates;
    if (provider === "local") {
      if (!LOCAL_MODEL) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "LOCAL_MODEL is not set on the server" } }));
      }
      upstreamUrl = LOCAL_BASE_URL + "/chat/completions";
      upstreamBody = makeBody(LOCAL_MODEL);
      candidates = [{ headers: { "Content-Type": "application/json" } }];
    } else {
      if (!GROQ_KEYS.length) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "GROQ_API_KEY / GROQ_API_KEYS is not set (set it in the environment or config.js)" } }));
      }
      upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
      upstreamBody = makeBody(GROQ_MODEL);
      candidates = GROQ_KEYS.map(key => ({
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` }
      }));
    }

    // Abort the upstream request if the client disconnects; add a hard timeout
    // for buffered (non-streaming) requests only.
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
          console.warn(`[proxy] request via candidate ${idx + 1}/${candidates.length} failed: ${e.message}`);
          continue;
        }
        // Key-related failures (rate limit / invalid key) → try the next key.
        const keyIssue = provider !== "local" && [401, 403, 429].includes(upRes.status);
        if (!upRes.ok && keyIssue) {
          const text = await upRes.text().catch(() => ""); // drain so the connection can be reused
          lastKeyErr = { status: upRes.status, text };
          console.warn(`[proxy] Groq key ${idx + 1}/${candidates.length} returned ${upRes.status}; trying next key`);
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
