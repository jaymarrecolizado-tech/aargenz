// Baseline security headers (P0), applied to every response before any route
// runs, so a newly added endpoint is covered by default. Mirrored in nginx in
// DEPLOYMENT.md because the Node port can also be reached directly.

import { COOKIE_SECURE, CSP_ENFORCE, CSP_POLICY, MAX_BODY_BYTES } from "../config.js";
import { sendJson } from "../lib/response.js";

export function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader(CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", CSP_POLICY);
}

// Refuse an oversized upload before routing, so a huge POST never reaches a
// route (or its memory) at all. Returns true when the request was rejected.
export function rejectOversizeBody(req, res) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength <= MAX_BODY_BYTES) return false;
  sendJson(res, 413, {
    error: { message: `Request body too large (limit ${Math.round(MAX_BODY_BYTES / 1048576)} MB)` }
  });
  return true;
}
