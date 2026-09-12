// Local config template - copy to config.js and add your keys
//
// NOTES
// - Deployed (Vercel/Netlify): prefer the server-side proxy (api/chat.js) and
//   set env vars instead: GROQ_API_KEY, AI_PROVIDER, LOCAL_BASE_URL, LOCAL_MODEL.
// - Local dev: run `GROQ_API_KEY=... AI_PROVIDER=local node server.js`
//   (reads config.js only when env vars are missing).
// - file:// usage: the keys set here are used directly by the browser.
//
// AI provider - swaps the live Groq-hosted model for a local model
// (Ollama / LM Studio / llama.cpp / vLLM). See LOCAL_AI_PLAN.md and
// LOCAL_AI_CONTINGENCY.md (offline fallback + model picks by hardware).
//   AI_PROVIDER: "contingency" (cloud first, LOCAL AS LAST RESORT — recommended
//                  for production: the office keeps working when credit runs
//                  out) | "auto" (local first, for fine-tune work) |
//                  "local" (local only) | "groq" (cloud only)
//   LOCAL_BASE_URL: base URL of the local OpenAI-compatible server
//   LOCAL_MODEL: model name served by the local server
//
//   LOCAL_JSON_MODE: true → send response_format {type:"json_object"} on every
//     LOCAL-model call (Phase 6). Only useful for fine-tuned models trained to
//     answer with a single JSON object; never applied to Groq/xAI. Server
//     equivalent: env LOCAL_JSON_MODE=1.
//
// Server-only knobs (env, not read from this file): CONTINGENCY_ENABLED=0 to
// disable the credit breaker, CONTINGENCY_COOLDOWN_MS, COOKIE_SECURE=1 behind
// TLS, CSP_ENFORCE=1, AUTH_RATE_MAX, MAX_BODY_BYTES.
//
// Responses stream (SSE) to the chat automatically when the provider supports
// it; OpenRouter is used as a last-resort cloud fallback when Groq fails.
const CONFIG = {
  // Single Groq API key — or use GROQ_API_KEYS (below) as a shared pool: when
  // the active key hits its rate limit (HTTP 429) or is rejected (401/403), the
  // app automatically retries with the next key in the pool.
  GROQ_API_KEY: "YOUR_GROQ_API_KEY",
  // Optional pool of Groq API keys (array or comma-separated string). Overrides
  // GROQ_API_KEY when set. Server mode also accepts GROQ_API_KEYS="k1,k2" as an
  // env var.
  GROQ_API_KEYS: ["YOUR_GROQ_API_KEY_1", "YOUR_GROQ_API_KEY_2"],
  // xAI (Grok) keys - the automatic FALLBACK provider. When every Groq key is
  // rate-limited (429) or rejected (401/403), the app automatically retries
  // against xAI's OpenAI-compatible API (https://api.x.ai/v1). Same pool
  // semantics as GROQ_API_KEYS. Server mode also accepts XAI_API_KEYS="k1,k2"
  // as an env var.
  XAI_API_KEY: "YOUR_XAI_API_KEY",
  XAI_API_KEYS: ["YOUR_XAI_API_KEY_1", "YOUR_XAI_API_KEY_2"],
  // xAI model to use for the fallback (default grok-4.6).
  XAI_MODEL: "grok-4.6",
  OPENROUTER_API_KEY: "YOUR_OPENROUTER_API_KEY",
  OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-versatile",
  // Contingency is the production default: cloud first, then the local model
  // once the cloud is out of credit or unreachable.
  AI_PROVIDER: "contingency",
  LOCAL_BASE_URL: "http://localhost:11434/v1",
  // Pick by hardware — see the table in LOCAL_AI_CONTINGENCY.md:
  //   8 GB VRAM  → qwen3:8b      16 GB VRAM → qwen3.6:27b (or qwen3:14b)
  //   CPU only   → phi4-mini     24 GB VRAM → qwen3.5:72b
  LOCAL_MODEL: "qwen3:8b",
  LOCAL_TIMEOUT_MS: 120000
};
