// Audit trail read/write (Phase 5.3).
//


import { getPool } from "../../db.js";

export async function handleAudit(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  // Audit trail read/write (Phase 5.3). GET is admin-only (who did what);
  // POST lets logged-in users record browser-side events (PDF/RTF exports
  // happen entirely client-side) from a small action whitelist.
  if (url.pathname === "/api/audit") {
    if (req.method === "GET") {
      const admin = await requireAdmin();
      if (!admin) return;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 200, 1), 1000);
      try {
        const [rows] = await getPool().query(
          "SELECT id, at, user_id, username, action, detail, provider, model FROM audit_log ORDER BY at DESC, id DESC LIMIT ?",
          [limit]
        );
        return sendJson(200, { entries: rows });
      } catch (e) {
        return sendJson(500, { error: { message: "Database error: " + e.message } });
      }
    }
    if (req.method === "POST") {
      const user = await getSessionUser(req);
      if (!user) return sendJson(401, { error: { message: "Login required" } });
      const body = await readBodyJson(req);
      const action = String(body?.action || "");
      // Whitelist: only client-generated lifecycle events may be recorded.
      if (!["export.pdf", "export.rtf", "report.preview"].includes(action)) {
        return sendJson(400, { error: { message: "Unknown audit action" } });
      }
      await writeAudit(user, action, { detail: body?.detail != null ? body.detail : null });
      return sendJson(200, { ok: true });
    }
    return sendJson(405, { error: { message: "Method not allowed" } });
  }
}
