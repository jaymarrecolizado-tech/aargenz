// Per-request context.
//
// Route handlers receive this instead of closing over the request handler's
// scope, which is what lets each route live in its own file. The helpers are
// thin adapters that bind `req`/`res`, so a route body still calls
// `sendJson(200, ...)` or `requireAdmin()` exactly as it did when every route
// was inline in server.js — the split did not require rewriting route logic.

import { rootDir } from "../config.js";
import { sendJson as sendJsonRaw } from "./response.js";
import { readBodyJson } from "../middleware/body.js";
import {
  getSessionUser as getSessionUserRaw,
  setSessionCookie as setSessionCookieRaw,
  requireAdmin as requireAdminRaw,
  writeAudit
} from "../middleware/session.js";

export function createContext(req, res, url) {
  return {
    req,
    res,
    url,
    // Project root, exposed under the name route bodies already use for
    // resolving templates/ and config.js.
    rootDir,

    sendJson: (status, obj) => sendJsonRaw(res, status, obj),
    getSessionUser: (r) => getSessionUserRaw(r || req),
    setSessionCookie: (r, token, maxAgeMs) => setSessionCookieRaw(r || res, token, maxAgeMs),
    requireAdmin: () => requireAdminRaw(req, res),
    readBodyJson: (r, maxBytes) => readBodyJson(r || req, maxBytes),
    writeAudit
  };
}
