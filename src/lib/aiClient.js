// AI provider plumbing shared by the app. Lets you swap the live Groq-hosted
// model for a local model (Ollama / LM Studio / llama.cpp / vLLM) via the
// OpenAI-compatible chat completions API. See LOCAL_AI_PLAN.md.
//
//   AI_PROVIDER: "groq"  → cloud only via Groq API (default)
//                "local" → local only (errors if unreachable)
//                "auto"  → local first, Groq fallback
//   LOCAL_BASE_URL: base URL of the local OpenAI-compatible server
//   LOCAL_MODEL: model name served by the local server

const CONFIG = () => (typeof window !== "undefined" && window.CONFIG) || {};

export const AI_DEFAULTS = {
  get AI_PROVIDER() { return CONFIG()?.AI_PROVIDER || "groq"; },
  get LOCAL_BASE_URL() { return (CONFIG()?.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""); },
  get LOCAL_MODEL() { return CONFIG()?.LOCAL_MODEL || "qwen3:14b"; },
  get LOCAL_TIMEOUT_MS() { return CONFIG()?.LOCAL_TIMEOUT_MS || 120000; }
};

export const loadAiOverrides = () => {
  try {
    const saved = JSON.parse(localStorage.getItem("aar-ai-config") || "null");
    return saved && typeof saved === "object" ? saved : {};
  } catch { return {}; }
};

export const effectiveAiConfig = (overrides = {}) => ({
  AI_PROVIDER: AI_DEFAULTS.AI_PROVIDER,
  LOCAL_BASE_URL: AI_DEFAULTS.LOCAL_BASE_URL,
  LOCAL_MODEL: AI_DEFAULTS.LOCAL_MODEL,
  LOCAL_TIMEOUT_MS: AI_DEFAULTS.LOCAL_TIMEOUT_MS,
  ...overrides
});

export const fetchWithTimeout = async (url, options, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const openAiBody = (messages, model, extra = {}) => JSON.stringify({
  model,
  max_tokens: 4000,
  temperature: 0.2, // lower temperature = more deterministic output
  // NOTE: no response_format here on purpose. The assistant collects data
  // ONE question at a time (see SYSTEM_PROMPT) and only emits the final
  // JSON at the end; forcing json_object on every turn makes strict models
  // (e.g. Groq's gpt-oss-120b) reject ordinary question turns. The final
  // JSON is guaranteed by the system prompt + robust extractJson().
  messages,
  ...extra
});

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (SSE). Calls onToken(fullText) as tokens
// arrive; falls back to buffered JSON parsing for proxies that don't stream.
// ---------------------------------------------------------------------------

export const readSseStream = async (res, onToken) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        fullText += delta;
        onToken?.(fullText);
      }
    } catch { /* ignore keepalive / comments */ }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handleLine);
  }
  if (buffer.trim()) handleLine(buffer);
  return fullText;
};

export const readCompletion = async (res, onToken) => {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || ct.includes("application/x-ndjson")) {
    const fullText = await readSseStream(res, onToken);
    if (fullText) return fullText;
    throw new Error("Empty streamed response");
  }
  // Buffered OpenAI JSON response (older proxies or error bodies)
  const data = await res.json().catch(() => ({}));
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error(data.error?.message || "Empty response (" + res.status + ")");
  onToken?.(text);
  return text;
};

const openrouterStream = async (messages, onToken) => {
  if (!CONFIG()?.OPENROUTER_API_KEY) {
    throw new Error("No OpenRouter API key available in config.js");
  }
  const model = CONFIG()?.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-versatile";
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG().OPENROUTER_API_KEY}`
    },
    body: openAiBody(messages, model, { stream: true })
  }, 90000);
  return readCompletion(res, onToken);
};

// Shared key-pool parser (file:// mode). Accepts either an array
// (XXX_API_KEYS: ["k1","k2"]) or a comma-separated string, and falls back
// to the single XXX_API_KEY. When the active key hits its rate limit
// (HTTP 429) or is rejected (401/403), the request retries with the next
// key in the pool automatically.
export const parseKeys = (listCfg, singleCfg) => {
  let list = Array.isArray(listCfg) ? listCfg : (typeof listCfg === "string" ? listCfg.split(",") : []);
  list = list.map(k => String(k).trim()).filter(Boolean);
  if (!list.length && singleCfg) list = [String(singleCfg).trim()];
  return list;
};
const getGroqKeys = () => parseKeys(CONFIG()?.GROQ_API_KEYS, CONFIG()?.GROQ_API_KEY);
// xAI (Grok) keys – the automatic fallback provider used when every Groq
// key is rate-limited or rejected.
const getXaiKeys = () => parseKeys(CONFIG()?.XAI_API_KEYS, CONFIG()?.XAI_API_KEY);

// Index of the last key that worked; new requests start from it so a
// healthy key is preferred and exhausted keys are only hit when they're the
// only option.
const groqKeyCursor = { current: 0 };
const xaiKeyCursor = { current: 0 };

// Tries every key in a provider pool (up to `passes` full rotations),
// streaming to onToken. Throws once the whole pool is exhausted; the error
// carries .keyExhausted = true when only key issues (429/401/403) were hit.
const poolStream = async ({ url, model, keys, cursor, label, messages, onToken }) => {
  let lastErr = null;
  let keyExhausted = true;
  const passes = 3; // up to 3 full rotations through the pool
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < keys.length; i++) {
      const idx = (cursor.current + i) % keys.length;
      try {
        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${keys[idx]}`
          },
          body: openAiBody(messages, model, { stream: true })
        }, 90000);
        if (!res.ok) {
          const status = res.status;
          const errText = await res.text().catch(() => "");
          // Key-related failures (rate limit / invalid key) → next key.
          if ([401, 403, 429].includes(status)) {
            console.warn(`${label} key ${idx + 1}/${keys.length} returned ${status}; trying next key`);
            lastErr = new Error(`${label} ${status}: ${errText.slice(0, 300) || "key rejected"}`);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          keyExhausted = false;
          throw new Error(`${label} ${status}: ${errText.slice(0, 300) || "unknown error"}`);
        }
        cursor.current = idx; // remember the key that worked
        return await readCompletion(res, onToken);
      } catch (e) {
        if (e.keyExhausted) throw e; // already classified by a nested pool
        lastErr = e;
        const retryable = /5\d\d|ECONN|fetch failed|network|timeout|abort/i.test(e.message || "");
        if (!retryable) { e.keyExhausted = false; throw e; }
        await new Promise(r => setTimeout(r, 500)); // transient — try next key
      }
    }
    // Finished a full pass without success: advance the cursor so the next
    // pass starts from a different key, with backoff between passes.
    cursor.current = (cursor.current + 1) % keys.length;
    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, pass)));
  }
  const err = lastErr || new Error(`All ${label} API keys failed`);
  err.keyExhausted = keyExhausted;
  throw err;
};

// Provider chain: Groq keys first, then xAI (Grok) keys as the automatic
// fallback when every Groq key is rate-limited / rejected.
const groqStream = async (messages, onToken) => {
  const tiers = [
    { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", keys: getGroqKeys(), cursor: groqKeyCursor, label: "Groq" },
    { url: "https://api.x.ai/v1/chat/completions", model: CONFIG()?.XAI_MODEL || "grok-4.6", keys: getXaiKeys(), cursor: xaiKeyCursor, label: "xAI" }
  ].filter(t => t.keys.length);
  if (!tiers.length) {
    throw new Error("No Groq/xAI API key available. Add GROQ_API_KEY/GROQ_API_KEYS (or XAI_API_KEY/XAI_API_KEYS) to config.js locally or deploy the api/chat proxy with them set.");
  }
  let lastErr = null;
  for (const tier of tiers) {
    try {
      return await poolStream({ ...tier, messages, onToken });
    } catch (e) {
      // Fall through to the next provider only when this pool was exhausted
      // by key issues (rate limit / rejected key). Other errors surface.
      if (!e.keyExhausted) throw e;
      lastErr = e;
      console.warn(`${tier.label} keys exhausted, trying next provider:`, e.message);
    }
  }
  throw lastErr || new Error("All API providers failed");
};

// Sends the conversation to the model, streaming tokens to onToken as they
// arrive. Resolution order:
//   1. /api/chat proxy (server mode) – routes to local model or Groq.
//   2. No proxy (file:// / static): local model directly ("local"/"auto"),
//      then Groq direct, then OpenRouter as a final cloud fallback.
export const streamChat = async (messages, onToken, overrides = {}) => {
  const cfg = effectiveAiConfig(overrides);

  try {
    const proxyRes = await fetchWithTimeout("api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: openAiBody(messages, cfg.LOCAL_MODEL, { provider: cfg.AI_PROVIDER, stream: true, templateId: cfg.templateId })
    }, 180000);
    if (proxyRes.ok) return await readCompletion(proxyRes, onToken);
    const errText = await proxyRes.text().catch(() => "");
    console.warn("Proxy returned " + proxyRes.status + ":", errText.slice(0, 200));
  } catch (e) {
    console.warn("Proxy unavailable:", e.message);
  }

  if (cfg.AI_PROVIDER !== "groq") {
    try {
      const res = await fetchWithTimeout(cfg.LOCAL_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: openAiBody(messages, cfg.LOCAL_MODEL, { stream: true })
      }, cfg.LOCAL_TIMEOUT_MS);
      return await readCompletion(res, onToken);
    } catch (e) {
      if (cfg.AI_PROVIDER === "local") throw e; // strict local mode
      console.warn("Local model unavailable, falling back to cloud:", e.message);
    }
  }

  try {
    return await groqStream(messages, onToken);
  } catch (groqErr) {
    if (CONFIG()?.OPENROUTER_API_KEY) {
      console.warn("Groq unavailable, trying OpenRouter:", groqErr.message);
      return await openrouterStream(messages, onToken);
    }
    throw groqErr;
  }
};
