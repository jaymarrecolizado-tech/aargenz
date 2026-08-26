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
// (Ollama / LM Studio / llama.cpp / vLLM). See LOCAL_AI_PLAN.md.
//   AI_PROVIDER: "auto" (default: local first, cloud fallback) | "local" | "groq"
//   LOCAL_BASE_URL: base URL of the local OpenAI-compatible server
//   LOCAL_MODEL: model name served by the local server
//
//   LOCAL_JSON_MODE: true → send response_format {type:"json_object"} on every
//     LOCAL-model call (Phase 6). Only useful for fine-tuned models trained to
//     answer with a single JSON object; never applied to Groq/xAI. Server
//     equivalent: env LOCAL_JSON_MODE=1.
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
  AI_PROVIDER: "auto",
  LOCAL_BASE_URL: "http://localhost:11434/v1",
  LOCAL_MODEL: "qwen3:14b",
  LOCAL_TIMEOUT_MS: 120000
};
