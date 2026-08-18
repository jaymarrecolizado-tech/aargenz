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
//   AI_PROVIDER: "auto" (local first, Groq fallback) | "local" | "groq"
//   LOCAL_BASE_URL: base URL of the local OpenAI-compatible server
//   LOCAL_MODEL: model name served by the local server
//
// Responses stream (SSE) to the chat automatically when the provider supports
// it; OpenRouter is used as a last-resort cloud fallback when Groq fails.
const CONFIG = {
  GROQ_API_KEY: "YOUR_GROQ_API_KEY",
  OPENROUTER_API_KEY: "YOUR_OPENROUTER_API_KEY",
  OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-versatile",
  AI_PROVIDER: "auto",
  LOCAL_BASE_URL: "http://localhost:11434/v1",
  LOCAL_MODEL: "qwen3:14b",
  LOCAL_TIMEOUT_MS: 120000
};
