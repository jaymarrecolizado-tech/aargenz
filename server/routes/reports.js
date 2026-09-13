// Reports API (Phase 3.2). Requires login — reports are owned by the
// authenticated user's id.
//


import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getPool } from "../../db.js";
import { normalizeReport, validateReportSchema, validateRawLlmJson } from "../../src/lib/report.js";
import { reportsToCsv } from "../lib/csv.js";
import { reserveControlSeq, formatControlNo, controlNumberField, readTemplateConfig } from "../lib/controlNumbers.js";
import { UUID_RE, expectedVersion } from "../lib/concurrency.js";
import { replaceReportPhotos, loadReportPhotos } from "../lib/photos.js";
import { STATUSES, TRANSITIONS, canTransition, isLockedFor, buildStamp } from "../lib/review.js";

export async function handleReports(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  // Reports API (Phase 3.2). Requires login — reports are owned by the
  // authenticated user's id.
  if (url.pathname === "/api/reports" || url.pathname.startsWith("/api/reports/")) {
    const user = await getSessionUser(req);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Login required" } }));
    }
    const pool = getPool();
    // XAMPP ships MariaDB, where JSON is an alias for LONGTEXT — values come
    // back as strings there but as parsed objects on MySQL (Hostinger VPS).
    // Normalize so clients always get real objects/arrays.
    const normalizeReportRow = (row) => {
      for (const key of ["conversation", "report", "photos"]) {
        if (typeof row[key] === "string") {
          try { row[key] = JSON.parse(row[key]); } catch { /* keep as-is */ }
        }
      }
      return row;
    };
    const reportId = url.pathname.split("/")[3]; // /api/reports/:id
    const photoSub = url.pathname.split("/")[4] === "photos"; // /api/reports/:id/photos
    const transitionSub = url.pathname.split("/")[4] === "transition"; // /api/reports/:id/transition
    let body = {};
    if (req.method === "POST" || req.method === "PUT") {
      // Bounded reader (P0) — this route used to buffer without any limit.
      body = await readBodyJson(req);
      if (body === null) return sendJson(400, { error: { message: "Invalid JSON body" } });
    }

    // Normalizes + validates a final report payload before it is persisted
    // (Phase 5.1). Returns { report } on success or { error } to reject.
    const sanitizeReportPayload = (rawReport, templateId) => {
      if (!rawReport || typeof rawReport !== "object" || !Object.keys(rawReport).length) {
        return { report: rawReport ?? null }; // drafts without data are fine
      }
      let tplCfg = null;
      try {
        tplCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "templates", String(templateId), "template.json"), "utf8"));
      } catch { tplCfg = null; }
      // Reject responses that aren't really a report before normalization
      // repairs them into empty-but-valid-looking data.
      const rawErrors = validateRawLlmJson(rawReport, tplCfg);
      if (rawErrors.length) {
        return { error: { message: "Report failed validation", details: rawErrors } };
      }
      const normalized = normalizeReport(rawReport, tplCfg);
      const errors = validateReportSchema(normalized, tplCfg);
      if (errors.length) {
        return { error: { message: "Report failed validation", details: errors } };
      }
      return { report: normalized };
    };

    try {
      // List the logged-in user's reports (metadata only; conversation/report
      // excluded). Admins can list everyone's with ?all=1, and anyone can narrow
      // to one lifecycle state with ?status= — which is how the reviewer queue
      // asks for "everything submitted".
      if (req.method === "GET" && !reportId) {
        const all = url.searchParams.get("all") === "1" && user.role === "admin";
        const requested = url.searchParams.get("status");
        const statusFilter = STATUSES.includes(requested) ? requested : null;
        if (requested && !statusFilter) {
          return sendJson(400, { error: { message: `Unknown status "${requested}"` } });
        }
        const where = [];
        const params = [];
        if (!all) { where.push("r.owner = ?"); params.push(user.id); }
        if (statusFilter) { where.push("r.status = ?"); params.push(statusFilter); }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

        // CSV download (Phase 6): ?format=csv exports the same view as a
        // spreadsheet — admins get everyone's rows with ?all=1, encoders
        // their own. Includes the flattened report JSON for monitoring.
        if (url.searchParams.get("format") === "csv") {
          const [rows] = await pool.query(
            `SELECT r.id, u.username AS owner_name, r.template_id, r.title, r.control_no, r.status,
                    r.report, r.created_at, r.updated_at
             FROM reports r LEFT JOIN users u ON u.id = r.owner
             ${whereSql}
             ORDER BY r.updated_at DESC`,
            params
          );
          writeAudit(user, "report.export.csv", {
            detail: `${rows.length} row(s)${all ? " (all users)" : ""}${statusFilter ? ` [${statusFilter}]` : ""}`
          });
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="aar-reports-${new Date().toISOString().slice(0, 10)}.csv"`
          });
          return res.end(reportsToCsv(rows));
        }
        const [rows] = await pool.query(
          `SELECT r.id, r.owner, u.username AS owner_name, r.template_id, r.title, r.control_no, r.status,
                  r.version, r.submitted_at, r.submitted_by_name, r.reviewed_at, r.reviewed_by_name, r.remarks,
                  (SELECT COUNT(*) FROM report_photos p WHERE p.report_id = r.id) AS photos_count,
                  r.created_at, r.updated_at
           FROM reports r LEFT JOIN users u ON u.id = r.owner
           ${whereSql}
           ORDER BY r.updated_at DESC`,
          params
        );
        return sendJson(200, rows);
      }

      // Lifecycle transitions (plan 3.1). Handled *before* the create branch,
      // and the create branch below is guarded on !reportId: previously a POST
      // to any /api/reports/<id>... path fell into "create a report" and failed
      // with "templateId is required".
      //
      // One endpoint for every transition keeps the rules in server/lib/review.js
      // rather than spread across five route names.
      if (transitionSub && reportId) {
        if (req.method !== "POST") return sendJson(405, { error: { message: "Method not allowed" } });
        const action = String(body?.action || "");
        const transition = TRANSITIONS[action];
        if (!transition) return sendJson(400, { error: { message: `Unknown action "${action}"` } });

        const [rows] = await pool.query(
          "SELECT owner, status, title FROM reports WHERE id = ?", [reportId]
        );
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        const row = rows[0];
        const isOwner = row.owner === user.id;
        if (!isOwner && user.role !== "admin") {
          return sendJson(403, { error: { message: "Not your report" } });
        }

        const allowed = canTransition(row.status, action, { role: user.role, isOwner });
        if (!allowed.ok) return sendJson(409, { error: { message: allowed.message }, status: row.status });

        const remarks = body?.remarks != null ? String(body.remarks).trim().slice(0, 4000) : null;
        if (transition.requiresRemarks && !remarks) {
          return sendJson(400, { error: { message: "A reason is required when rejecting a report." } });
        }

        // The expected status rides in the WHERE, so two reviewers cannot both
        // approve the same submission — the loser's affectedRows is 0.
        const stamp = buildStamp(action, user, remarks);
        const [r] = await pool.query(
          `UPDATE reports SET status = ?, ${stamp.sets.join(", ")} WHERE id = ? AND status = ?`,
          [transition.to, ...stamp.params, reportId, row.status]
        );
        if (r.affectedRows === 0) {
          return sendJson(409, {
            error: { message: "This report changed while you were looking at it. Reload and try again." },
            code: "status_conflict"
          });
        }
        writeAudit(user, `report.${action}`, {
          detail: `${reportId} — ${row.title || "untitled"} (${row.status} → ${transition.to})`
            + (remarks ? `: ${remarks.slice(0, 120)}` : "")
        });
        return sendJson(200, { ok: true, status: transition.to });
      }

      // Create a new report.
      if (req.method === "POST" && !reportId) {
        if (!body.templateId) {
          return sendJson(400, { error: { message: "templateId is required" } });
        }
        // Idempotent create (plan 2.7). The client generates the id and reuses it
        // when retrying a save whose response was lost, so a retry returns the
        // row that already exists instead of filing a second copy of the draft.
        // Checked BEFORE the control number is reserved so a retry doesn't burn
        // a sequence number.
        const requestedId = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
        const id = requestedId || crypto.randomUUID();
        if (requestedId) {
          const [dupe] = await pool.query(
            "SELECT owner, control_no, version FROM reports WHERE id = ?", [id]
          );
          if (dupe.length) {
            // Never confirm the existence of another user's report.
            if (dupe[0].owner !== user.id) {
              return sendJson(409, { error: { message: "That report id is already in use" } });
            }
            return sendJson(200, {
              id, controlNo: dupe[0].control_no, version: dupe[0].version, deduplicated: true
            });
          }
        }
        const checked = sanitizeReportPayload(body.report, body.templateId);
        if (checked.error) return sendJson(422, checked.error);

        // Plan 3.2: a template that opts in gets a server-issued control number,
        // reserved atomically so two encoders can never collide on one. It is
        // stored on the row (UNIQUE) and injected into the report data so the
        // preview and the PDF show it without any extra plumbing.
        let controlNo = null;
        const tplCfg = readTemplateConfig(body.templateId);
        const cnField = controlNumberField(tplCfg);
        if (cnField) {
          const seq = await reserveControlSeq(pool, String(body.templateId), new Date().getFullYear());
          controlNo = formatControlNo(tplCfg.controlPrefix, seq);
          if (checked.report) checked.report[cnField.id] = controlNo;
        }

        try {
          await pool.query(
            `INSERT INTO reports (id, owner, template_id, title, control_no, status, conversation, report)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              user.id,
              String(body.templateId),
              body.title != null ? String(body.title) : null,
              controlNo,
              // A new report always starts its life as a draft (plan 3.1). The
              // client used to send status here, which meant every autosave
              // re-marked the row; the lifecycle now moves it explicitly.
              "draft",
              body.conversation != null ? JSON.stringify(body.conversation) : null,
              checked.report != null ? JSON.stringify(checked.report) : null
            ]
          );
        } catch (e) {
          // Two identical creates raced past the existence check above. The
          // loser returns the winner's row instead of a 500 — that is the whole
          // point of the idempotency key. The sequence number it reserved is
          // simply left unused, which is why control numbers may have gaps.
          if (e?.code === "ER_DUP_ENTRY" && requestedId) {
            const [dupe] = await pool.query(
              "SELECT owner, control_no, version FROM reports WHERE id = ?", [id]
            );
            if (dupe.length && dupe[0].owner === user.id) {
              return sendJson(200, {
                id, controlNo: dupe[0].control_no, version: dupe[0].version, deduplicated: true
              });
            }
          }
          throw e;
        }
        // Photos go to their own table (2.6). Accepted here so a client that
        // still sends them on create keeps working.
        if (Array.isArray(body.photos) && body.photos.length) {
          const saved = await replaceReportPhotos(pool, id, body.photos);
          if (saved.error) {
            console.warn("[reports] create: photos rejected —", saved.error.message);
          }
        }
        writeAudit(user, "report.create", {
          detail: `${id} — ${body.title || "untitled"} (${body.templateId})${controlNo ? ` [${controlNo}]` : ""}`
        });
        return sendJson(201, { id, controlNo, version: 1 });
      }

      if (reportId) {
      // Non-admins may only touch their own reports.
      const canTouch = (row) => user.role === "admin" || row.owner === user.id;

      // The edit lock (plan 3.1). Enforced here rather than only in the UI, so
      // an approved record really is immutable and a submitted one cannot be
      // changed out from under its reviewer.
      const lockedResponse = (status) => sendJson(409, {
        error: {
          message: status === "approved"
            ? "This report has been approved and can no longer be edited. Ask a reviewer to reopen it."
            : "This report is with a reviewer, so it is locked while they read it. Withdraw it to make changes."
        },
        code: "report_locked",
        status
      });

      // Photos (plan 2.6): fetched separately from the report row so a draft's
      // megabytes of base64 no longer ride along with every read.
      if (photoSub && reportId) {
        const [rows] = await pool.query("SELECT owner, photos, status FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });

        if (req.method === "GET") {
          return sendJson(200, { photos: await loadReportPhotos(pool, reportId) });
        }
        if (req.method === "PUT") {
          if (isLockedFor(rows[0].status, user, rows[0].owner === user.id)) {
            return lockedResponse(rows[0].status);
          }
          const saved = await replaceReportPhotos(pool, reportId, body.photos);
          if (saved.error) return sendJson(422, saved.error);
          writeAudit(user, "report.photos", { detail: `${reportId} — ${saved.count} photo(s)` });
          return sendJson(200, { ok: true, count: saved.count });
        }
        return sendJson(405, { error: { message: "Method not allowed" } });
      }

      // Fetch one report. Photos are deliberately NOT included — call
      // /api/reports/:id/photos for those.
      if (req.method === "GET" && reportId) {
        const [rows] = await pool.query("SELECT * FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
        const row = normalizeReportRow(rows[0]);
        const [[pc]] = await pool.query(
          "SELECT COUNT(*) AS n FROM report_photos WHERE report_id = ?", [reportId]
        );
        row.photos_count = pc.n || (Array.isArray(row.photos) ? row.photos.length : 0);
        delete row.photos;
        return sendJson(200, row);
      }
      // Update mutable fields.
      if (req.method === "PUT" && reportId) {
        const [rows] = await pool.query("SELECT owner, version, status FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
        if (isLockedFor(rows[0].status, user, rows[0].owner === user.id)) {
          return lockedResponse(rows[0].status);
        }
        const sets = [];
        const params = [];
        if ("title" in body) { sets.push("title = ?"); params.push(body.title != null ? String(body.title) : null); }
        // `status` is deliberately NOT writable here any more. It is the
        // lifecycle field (plan 3.1) and only POST /:id/transition may move it —
        // otherwise any client could PUT status:"approved" and self-approve.
        if ("conversation" in body) { sets.push("conversation = ?"); params.push(body.conversation != null ? JSON.stringify(body.conversation) : null); }
        if ("report" in body) {
          const tplId = body.templateId || (await pool.query("SELECT template_id FROM reports WHERE id = ?", [reportId]))[0][0]?.template_id;
          const checked = sanitizeReportPayload(body.report, tplId);
          if (checked.error) return sendJson(422, checked.error);
          sets.push("report = ?");
          params.push(checked.report != null ? JSON.stringify(checked.report) : null);
        }
        // Photos are no longer a column on this row (2.6) — they go to their
        // own table below, which also keeps them out of the autosave payload.
        if (!sets.length && !("photos" in body)) {
          return sendJson(400, { error: { message: "Nothing to update" } });
        }
        // Optimistic concurrency (plan 2.7). The version check rides inside the
        // UPDATE so there is no read-then-write window: if another client saved
        // in the meantime, affectedRows is 0 and we hand back 409 with the
        // current version so the user can choose which copy to keep.
        const expect = expectedVersion(body);
        let newVersion = rows[0].version;
        if (sets.length) {
          const guarded = expect !== undefined;
          const sql = `UPDATE reports SET ${sets.join(", ")}, version = version + 1 WHERE id = ?`
            + (guarded ? " AND version = ?" : "");
          params.push(reportId);
          if (guarded) params.push(expect);
          const [r] = await pool.query(sql, params);
          if (guarded && r.affectedRows === 0) {
            const [[cur]] = await pool.query("SELECT version FROM reports WHERE id = ?", [reportId]);
            return sendJson(409, {
              error: {
                message: "This report was changed somewhere else since you opened it. "
                  + "Reload the other version, or keep yours and overwrite it."
              },
              code: "version_conflict",
              version: cur?.version ?? null
            });
          }
          newVersion = guarded ? expect + 1 : rows[0].version + 1;
        }
        if ("photos" in body && Array.isArray(body.photos)) {
          const saved = await replaceReportPhotos(pool, reportId, body.photos);
          if (saved.error) return sendJson(422, saved.error);
        }
        writeAudit(user, "report.update", { detail: reportId });
        return sendJson(200, { ok: true, version: newVersion });
      }
      // Delete a report. report_photos rows go with it via ON DELETE CASCADE.
      if (req.method === "DELETE" && reportId) {
        const [rows] = await pool.query("SELECT owner, status FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
        // An approved report is the official record — it cannot be deleted. A
        // reviewer reopens it first, which leaves an audit trail.
        if (rows[0].status === "approved") {
          return sendJson(409, {
            error: { message: "This report has been approved and cannot be deleted. Ask a reviewer to reopen it first." },
            code: "report_locked",
            status: "approved"
          });
        }
        await pool.query("DELETE FROM reports WHERE id = ?", [reportId]);
        writeAudit(user, "report.delete", { detail: `${reportId} (${rows[0].status})` });
        return sendJson(200, { ok: true });
      }
      }

      return sendJson(405, { error: { message: "Method not allowed" } });
    } catch (e) {
      console.error("[reports]", e.message);
      return sendJson(500, { error: { message: "Database error: " + e.message } });
    }
  }
}
