// User management (Phase 9): admin-only CRUD over accounts.
//


import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "../../db.js";

export async function handleUsers(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  // ---- User management (Phase 9): admin-only CRUD over accounts -------------
  // GET    /api/users              list users (+ report/session counts)
  // POST   /api/users              create {username, password, role}
  // PUT    /api/users/:id          change role {role}
  // PUT    /api/users/:id/password reset password {password} (signs out sessions)
  // DELETE /api/users/:id          delete account (sessions cascade; reports kept)
  if (url.pathname === "/api/users" || url.pathname.startsWith("/api/users/")) {
    const admin = await requireAdmin();
    if (!admin) return;
    const pool = getPool();
    const targetId = url.pathname.split("/")[3]; // /api/users/:id
    try {
      if (req.method === "GET" && !targetId) {
        const [rows] = await pool.query(
          `SELECT u.id, u.username, u.role, u.created_at,
                  (SELECT COUNT(*) FROM reports r WHERE r.owner = u.id) AS reports,
                  (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW()) AS sessions
           FROM users u ORDER BY u.created_at ASC`
        );
        return sendJson(200, rows);
      }

      if (req.method === "POST" && !targetId) {
        const body = await readBodyJson(req);
        const username = String(body?.username || "").trim();
        const password = String(body?.password || "");
        const role = body?.role === "admin" ? "admin" : "encoder";
        if (username.length < 3 || username.length > 64) {
          return sendJson(400, { error: { message: "Username must be 3-64 characters" } });
        }
        if (password.length < 6) {
          return sendJson(400, { error: { message: "Password must be at least 6 characters" } });
        }
        const id = crypto.randomUUID();
        const hash = await bcrypt.hash(password, 10);
        try {
          await pool.query(
            "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
            [id, username, hash, role]
          );
        } catch (e) {
          if (e.code === "ER_DUP_ENTRY") {
            return sendJson(409, { error: { message: "Username is already taken" } });
          }
          throw e;
        }
        writeAudit(admin, "user.create", { detail: `${username} (${role})` });
        return sendJson(201, { id, username, role });
      }

      if (targetId) {
        const [rows] = await pool.query("SELECT id, username, role FROM users WHERE id = ?", [targetId]);
        const target = rows[0];
        if (!target) return sendJson(404, { error: { message: "User not found" } });

        // Reset password: admin sets a new one directly; the user's active
        // sessions are revoked so the new credential takes effect at once.
        if (req.method === "PUT" && url.pathname.endsWith("/password")) {
          const body = await readBodyJson(req);
          const password = String(body?.password || "");
          if (password.length < 6) {
            return sendJson(400, { error: { message: "Password must be at least 6 characters" } });
          }
          const hash = await bcrypt.hash(password, 10);
          await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, target.id]);
          await pool.query("DELETE FROM sessions WHERE user_id = ?", [target.id]);
          writeAudit(admin, "user.password_reset", { detail: target.username });
          return sendJson(200, { ok: true });
        }

        // Change role.
        if (req.method === "PUT") {
          const body = await readBodyJson(req);
          const role = body?.role;
          if (role !== "admin" && role !== "encoder") {
            return sendJson(400, { error: { message: 'role must be "admin" or "encoder"' } });
          }
          if (target.id === admin.id) {
            return sendJson(400, { error: { message: "You cannot change your own role" } });
          }
          if (target.role === "admin" && role !== "admin") {
            const [[counts]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
            if (counts.n <= 1) return sendJson(400, { error: { message: "Cannot demote the last admin" } });
          }
          await pool.query("UPDATE users SET role = ? WHERE id = ?", [role, target.id]);
          writeAudit(admin, "user.role", { detail: `${target.username}: ${target.role} → ${role}` });
          return sendJson(200, { ok: true });
        }

        // Delete account. Sessions cascade via FK; the user's reports are
        // intentionally KEPT (government records) — they just lose their owner.
        if (req.method === "DELETE") {
          if (target.id === admin.id) {
            return sendJson(400, { error: { message: "You cannot delete your own account" } });
          }
          if (target.role === "admin") {
            const [[counts]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
            if (counts.n <= 1) return sendJson(400, { error: { message: "Cannot delete the last admin" } });
          }
          await pool.query("DELETE FROM users WHERE id = ?", [target.id]);
          writeAudit(admin, "user.delete", { detail: `${target.username} (${target.role})` });
          return sendJson(200, { ok: true });
        }
      }

      return sendJson(405, { error: { message: "Method not allowed" } });
    } catch (e) {
      console.error("[users]", e.message);
      return sendJson(500, { error: { message: "Database error: " + e.message } });
    }
  }
}
