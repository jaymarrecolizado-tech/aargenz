// Login, registration, logout, session probe and self-service password change.
//


import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "../../db.js";
import { SESSION_COOKIE, SESSION_TTL_MS, parseCookies, setSessionCookie } from "../middleware/session.js";
import { AUTH_RATE_WINDOW_MS, authBlocked, authPenalize, authForgive } from "../middleware/rateLimit.js";

export async function handleAuth(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  if (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    }
    const body = await readBodyJson(req);
    if (!body || !body.username || !body.password) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "username and password are required" } }));
    }
    const username = String(body.username).trim();
    if (username.length < 3 || username.length > 64) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Username must be 3-64 characters" } }));
    }
    if (String(body.password).length < 6) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Password must be at least 6 characters" } }));
    }

    // Throttle credential attempts on both the source IP and the target
    // username (P0) — neither a single host nor a single account can be
    // hammered. Counters clear on a successful login.
    const isLogin = url.pathname === "/api/auth/login";
    const ipKey = `ip:${req.socket.remoteAddress || "unknown"}`;
    const userKey = `user:${username.toLowerCase()}`;
    if (isLogin && (authBlocked(userKey) || authBlocked(ipKey))) {
      const byUser = authBlocked(userKey);
      writeAudit(null, "auth.throttled", { detail: `${username} (${byUser ? "username" : "ip"})` });
      const mins = Math.ceil(AUTH_RATE_WINDOW_MS / 60000);
      return sendJson(429, {
        error: {
          message: byUser
            ? `Too many sign-in attempts for "${username}". Try again in ${mins} minutes, or ask an admin to reset the password.`
            : `Too many sign-in attempts from this network. Try again in ${mins} minutes.`
        }
      });
    }

    try {
      const pool = getPool();
      let user;
      if (url.pathname === "/api/auth/register") {
        // The very first account bootstraps the admin; everyone after is an encoder.
        const [existing] = await pool.query("SELECT id FROM users");
        const role = existing.length === 0 ? "admin" : "encoder";
        const id = crypto.randomUUID();
        const hash = await bcrypt.hash(String(body.password), 10);
        try {
          await pool.query(
            "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
            [id, username, hash, role]
          );
        } catch (e) {
          if (e.code === "ER_DUP_ENTRY") {
            res.writeHead(409, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "Username is already taken" } }));
          }
          throw e;
        }
        user = { id, username, role };
      } else {
        const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
        const found = rows[0];
        if (!found || !(await bcrypt.compare(String(body.password), found.password_hash))) {
          authPenalize(ipKey);
          authPenalize(userKey);
          writeAudit(null, "auth.login_failed", { detail: username });
          return sendJson(401, { error: { message: "Invalid username or password" } });
        }
        user = { id: found.id, username: found.username, role: found.role };
      }
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))",
        [token, user.id, Math.floor(SESSION_TTL_MS / 1000)]
      );
      authForgive(ipKey);
      authForgive(userKey);
      await writeAudit(user, url.pathname.endsWith("/register") ? "auth.register" : "auth.login");
      setSessionCookie(res, token, SESSION_TTL_MS);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(user));
    } catch (e) {
      console.error("[auth]", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Database error: " + e.message } }));
    }
  }

  if (url.pathname === "/api/auth/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    let logoutUser = null;
    if (token) {
      try {
        logoutUser = await getSessionUser(req);
        await getPool().query("DELETE FROM sessions WHERE token = ?", [token]);
      } catch { /* best effort */ }
    }
    writeAudit(logoutUser, "auth.logout");
    setSessionCookie(res, "", 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === "/api/auth/me") {
    const user = await getSessionUser(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(user || null));
  }

  // Self-service password change (P0). Until now only an admin could reset a
  // password, so an encoder who suspected a leak had no way to rotate it.
  // Requires the current password, and revokes every *other* session.
  if (url.pathname === "/api/auth/password") {
    if (req.method !== "POST") return sendJson(405, { error: { message: "Method not allowed" } });
    const user = await getSessionUser(req);
    if (!user) return sendJson(401, { error: { message: "Login required" } });
    const body = await readBodyJson(req);
    const currentPassword = String(body?.currentPassword || "");
    const newPassword = String(body?.newPassword || "");
    if (!currentPassword || !newPassword) {
      return sendJson(400, { error: { message: "currentPassword and newPassword are required" } });
    }
    if (newPassword.length < 6) {
      return sendJson(400, { error: { message: "New password must be at least 6 characters" } });
    }
    if (newPassword === currentPassword) {
      return sendJson(400, { error: { message: "New password must be different from the current one" } });
    }
    try {
      const pool = getPool();
      const [rows] = await pool.query("SELECT password_hash FROM users WHERE id = ?", [user.id]);
      if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
        authPenalize(`user:${user.username.toLowerCase()}`);
        writeAudit(user, "auth.password_change_failed");
        return sendJson(401, { error: { message: "Current password is incorrect" } });
      }
      await pool.query(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        [await bcrypt.hash(newPassword, 10), user.id]
      );
      // Keep the caller signed in, drop every other device.
      const keepToken = parseCookies(req)[SESSION_COOKIE];
      await pool.query("DELETE FROM sessions WHERE user_id = ? AND token <> ?", [user.id, keepToken || ""]);
      writeAudit(user, "auth.password_change");
      return sendJson(200, { ok: true });
    } catch (e) {
      console.error("[auth:password]", e.message);
      return sendJson(500, { error: { message: "Database error: " + e.message } });
    }
  }
}
