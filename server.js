// Local development server for the AAR Generator.
//
// This file is wiring only — every route lives under server/routes/, shared
// helpers under server/lib/ and server/middleware/. See UPGRADE-PLAN.md §5.1 for
// why: adding an endpoint used to mean editing a 1,800-line file in which route
// order determined correctness.
//
// Serves the static files AND proxies /api/chat to either a local model
// (Ollama / LM Studio / llama.cpp / vLLM) or Groq, so API keys stay server-side.
// Streaming (SSE) responses are piped through as-is when the client requests
// them with { stream: true }.
//
// Usage:
//   GROQ_API_KEY=your_key AI_PROVIDER=local node server.js
//   GROQ_API_KEYS=key1,key2 node server.js   (pool: auto-rotate on 429/401/403)
//   XAI_API_KEY=key node server.js           (xAI/Grok fallback when every Groq
//                                              key is rate-limited/rejected)
//   (AI_PROVIDER: "contingency" (recommended) | "auto" | "groq" | "local";
//    keys fall back to config.js)
//
// Then open http://localhost:3000

import http from "node:http";

import { PORT, AI_PROVIDER } from "./server/config.js";
import { createContext } from "./server/lib/context.js";
import { sendJson } from "./server/lib/response.js";
import { applySecurityHeaders, rejectOversizeBody } from "./server/middleware/security.js";

import { handleAudit } from "./server/routes/audit.js";
import { handleTemplates } from "./server/routes/templates.js";
import { handleUsers } from "./server/routes/users.js";
import { handleAuth } from "./server/routes/auth.js";
import { handleReports } from "./server/routes/reports.js";
import { handleAnalytics } from "./server/routes/analytics.js";
import { handleAiStatus } from "./server/routes/ai.js";
import { handleChat } from "./server/routes/chat.js";
import { handleStatic } from "./server/routes/static.js";

// Tried top-down; the first handler to write a response claims the request. That
// is the same "route order matters" behaviour the single-handler version had —
// the order now lives in this array instead of the physical order of the file.
// Most-specific paths must come before more general ones, exactly as before.
const API_ROUTES = [
  handleAudit,
  handleTemplates,
  handleUsers,
  handleAuth,
  handleReports,
  handleAnalytics,
  handleAiStatus,
  handleChat
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Applied before routing so a newly added endpoint is covered by default.
  applySecurityHeaders(res);
  if (rejectOversizeBody(req, res)) return;

  const ctx = createContext(req, res, url);

  for (const route of API_ROUTES) {
    try {
      await route(ctx);
    } catch (e) {
      // Route bodies do their own error handling; reaching here means something
      // escaped it, which previously left the request hanging with no response.
      console.error(`[${route.name}]`, e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: "Internal server error" } });
      return;
    }
    // A handler that responded has claimed the request. This is how the
    // dispatcher knows whether to keep going — no handler returns a flag, which
    // is what let the route bodies move across unchanged.
    if (res.headersSent) return;
  }

  // Static files are the terminal fallback and reply asynchronously, so they sit
  // outside the loop: headersSent is still false when the handler returns.
  await handleStatic(ctx);
});

server.listen(PORT, () => {
  console.log(`AAR Generator running at http://localhost:${PORT} (AI provider: ${AI_PROVIDER})`);
});
