// Template registry, per-template config, personnel lists and logo files.
//


import fs from "node:fs";
import path from "node:path";
import { getPool } from "../../db.js";
import { validateTemplateConfig, saveTemplateFile, decodeDataUrl, logoUrl, LOGO_KINDS, LOGO_MIME_EXT } from "../lib/templateConfig.js";

export async function handleTemplates(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  if (url.pathname === "/api/templates") {
    // Template registry (Phase 2): lists every template under templates/.
    // Personnel lists managed by admins (Phase 8) live in the DB's templates
    // table and override the file values; adding a new DICT project = drop a
    // folder in templates/ and add it to templates/index.json.
    try {
      let dbPersonnel = {};
      try {
        const [rows] = await getPool().query("SELECT id, config FROM templates WHERE config IS NOT NULL");
        for (const row of rows) {
          const cfg = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
          if (Array.isArray(cfg?.personnel)) dbPersonnel[row.id] = cfg.personnel;
        }
      } catch { /* DB unavailable — file personnel only */ }
      const indexPath = path.join(__dirname, "templates", "index.json");
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      const templates = (index.templates || []).map(entry => {
        const id = typeof entry === "string" ? entry : entry.id;
        try {
          const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "templates", id, "template.json"), "utf8"));
          if (dbPersonnel[id]) tpl.personnel = dbPersonnel[id];
          return tpl;
        } catch {
          return { id, name: entry?.name || id, error: "template.json missing or invalid" };
        }
      }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(templates));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Failed to load template registry: " + e.message } }));
    }
  }

  // Per-template config read/write (Phase 8.3, admin-only writes).
  // GET returns the effective template (file + DB personnel override);
  // PUT validates and persists a full template config written to disk.
  const singleTplMatch = url.pathname.match(/^\/api\/templates\/([\w-]+)$/);
  if (singleTplMatch) {
    const templateId = singleTplMatch[1];
    const tplPath = path.join(__dirname, "templates", templateId, "template.json");

    if (req.method === "GET") {
      const user = await getSessionUser(req);
      if (!user) return sendJson(401, { error: { message: "Login required" } });
      try {
        let tpl;
        try {
          tpl = JSON.parse(fs.readFileSync(tplPath, "utf8"));
        } catch {
          return sendJson(404, { error: { message: "Template not found" } });
        }
        try {
          const [rows] = await getPool().query("SELECT config FROM templates WHERE id = ?", [templateId]);
          if (rows[0]) {
            const cfg = typeof rows[0].config === "string" ? JSON.parse(rows[0].config) : rows[0].config;
            if (Array.isArray(cfg?.personnel)) tpl.personnel = cfg.personnel;
          }
        } catch { /* DB unavailable — file only */ }
        return sendJson(200, tpl);
      } catch (e) {
        return sendJson(500, { error: { message: e.message } });
      }
    }

    if (req.method === "PUT") {
      const admin = await requireAdmin();
      if (!admin) return;
      const body = await readBodyJson(req);
      if (body && typeof body === "object") body.id = templateId;
      const errors = validateTemplateConfig(body);
      if (errors.length) return sendJson(422, { error: { message: "Invalid template", details: errors } });
      try {
        saveTemplateFile(body);
        writeAudit(admin, "template.save", { detail: `${templateId} — ${body.name || ""}` });
        return sendJson(200, body);
      } catch (e) {
        console.error("[template save]", e.message);
        return sendJson(500, { error: { message: "Failed to save template: " + e.message } });
      }
    }

    return sendJson(405, { error: { message: "Method not allowed" } });
  }

  // Per-template personnel list: GET for any logged-in user, PUT admin-only
  // (stored in the templates table so no redeploy is needed).
  const personnelMatch = url.pathname.match(/^\/api\/templates\/([\w-]+)\/personnel$/);
  if (personnelMatch) {
    const templateId = personnelMatch[1];
    const pool = getPool();
    const readStored = async () => {
      const [rows] = await pool.query("SELECT config FROM templates WHERE id = ?", [templateId]);
      const cfg = rows[0] ? (typeof rows[0].config === "string" ? JSON.parse(rows[0].config) : rows[0].config) : null;
      return Array.isArray(cfg?.personnel) ? cfg.personnel : null;
    };
    if (req.method === "GET") {
      const user = await getSessionUser(req);
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Login required" } }));
      }
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(await readStored() || []));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Database error: " + e.message } }));
      }
    }
    if (req.method === "PUT") {
      const admin = await requireAdmin();
      if (!admin) return;
      const body = await readBodyJson(req);
      if (!Array.isArray(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Expected an array of {name, position}" } }));
      }
      const personnel = body
        .map(p => ({ name: String(p?.name || "").trim(), position: String(p?.position || "").trim() }))
        .filter(p => p.name);
      try {
        await pool.query(
          `INSERT INTO templates (id, name, config) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE config = VALUES(config)`,
          [templateId, templateId, JSON.stringify({ personnel })]
        );
        writeAudit(admin, "personnel.save", { detail: `${templateId} (${personnel.length} people)` });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(personnel));
      } catch (e) {
        console.error("[personnel]", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Database error: " + e.message } }));
      }
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
  }

  // Per-template default header/footer logo (Phase 8.4, admin-only).
  // POST { kind, dataUrl } stores the image under templates/<id>/ and returns
  // its URL for template.json's headerLogo/footerLogo; DELETE removes the file.
  const logoMatch = url.pathname.match(/^\/api\/templates\/([\w-]+)\/logo$/);
  if (logoMatch) {
    const admin = await requireAdmin();
    if (!admin) return;
    const templateId = logoMatch[1];
    if (!/^[\w-]+$/.test(templateId) || templateId.includes("..")) {
      return sendJson(400, { error: { message: "Invalid template id" } });
    }
    const dir = path.join(__dirname, "templates", templateId);
    if (req.method === "POST") {
      const body = await readBodyJson(req);
      const kind = String(body?.kind || "");
      if (!LOGO_KINDS[kind]) {
        return sendJson(400, { error: { message: 'kind must be "header" or "footer"' } });
      }
      const decoded = decodeDataUrl(body?.dataUrl);
      if (decoded.error) return sendJson(422, { error: { message: decoded.error } });
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Replace any previous upload regardless of old extension.
        for (const oldExt of Object.values(LOGO_MIME_EXT)) {
          fs.rmSync(path.join(dir, LOGO_KINDS[kind] + oldExt), { force: true });
        }
        const file = LOGO_KINDS[kind] + decoded.ext;
        fs.writeFileSync(path.join(dir, file), decoded.buf);
        writeAudit(admin, "logo.upload", { detail: `${templateId} ${kind}` });
        return sendJson(200, { url: logoUrl(templateId, kind, decoded.ext) });
      } catch (e) {
        console.error("[template logo]", e.message);
        return sendJson(500, { error: { message: "Failed to save logo: " + e.message } });
      }
    }
    if (req.method === "DELETE") {
      const kind = url.searchParams.get("kind") || "";
      if (!LOGO_KINDS[kind]) {
        return sendJson(400, { error: { message: 'kind must be "header" or "footer"' } });
      }
      try {
        for (const ext of Object.values(LOGO_MIME_EXT)) {
          fs.rmSync(path.join(dir, LOGO_KINDS[kind] + ext), { force: true });
        }
        writeAudit(admin, "logo.delete", { detail: `${templateId} ${kind}` });
        return sendJson(200, { ok: true });
      } catch (e) {
        return sendJson(500, { error: { message: "Failed to remove logo: " + e.message } });
      }
    }
    return sendJson(405, { error: { message: "Method not allowed" } });
  }
}
