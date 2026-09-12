// Session cookie handling.
// Auth is a server-side session row keyed by an HttpOnly cookie; nothing is
// stored in the browser except the opaque token.


import { COOKIE_SECURE } from "../config.js";
import { getPool } from "../../db.js";
import { sendJson } from "../lib/response.js";

export const SESSION_COOKIE = "aar_sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const parseCookies = (req) => {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

// Resolves the logged-in user from the session cookie, or null.
export const getSessionUser = async (req) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const [rows] = await getPool().query(
      `SELECT u.id, u.username, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [token]
    );
    return rows[0] || null;
  } catch {
    return null; // DB unavailable → treat as not logged in
  }
};

export const setSessionCookie = (res, token, maxAgeMs) => {
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax;` +
    (COOKIE_SECURE ? " Secure;" : "") +
    ` Max-Age=${Math.floor(maxAgeMs / 1000)}`);
};

// ---- Expired-session sweep (P0) -------------------------------------------
// Sessions were only deleted on logout or password reset, while expiry was
// checked at read time — so the table grew forever. Sweep hourly.
export const sweepExpiredSessions = () => {
  getPool()
    .query("DELETE FROM sessions WHERE expires_at < NOW()")
    .then(([r]) => { if (r.affectedRows) console.log(`[sessions] swept ${r.affectedRows} expired session(s)`); })
    .catch(() => { /* DB not reachable yet — the next tick retries */ });
};
setInterval(sweepExpiredSessions, 60 * 60 * 1000).unref();

// Admin-only guard for template management endpoints.
export async function requireAdmin(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: { message: "Login required" } });
    return null;
  }
  if (user.role !== "admin") {
    sendJson(res, 403, { error: { message: "Admin access required" } });
    return null;
  }
  return user;
}

// Audit trail (Phase 5.3): best-effort INSERT — logging must never break or
// slow down the request it describes.
export async function writeAudit(user, action, { detail = null, provider = null, model = null } = {}) {
  try {
    await getPool().query(
      "INSERT INTO audit_log (user_id, username, action, detail, provider, model) VALUES (?, ?, ?, ?, ?, ?)",
      [user?.id || null, user?.username || null,
       String(action).slice(0, 64),
       detail != null ? String(detail).slice(0, 255) : null,
       provider ? String(provider).slice(0, 32) : null,
       model ? String(model).slice(0, 64) : null]
    );
  } catch (e) {
    console.warn("[audit] insert failed:", e.message);
  }
}
