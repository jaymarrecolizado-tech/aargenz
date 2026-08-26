// Local development server for the AAR Generator.
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
//   (AI_PROVIDER: "groq" (default) | "local"; keys fall back to config.js)
//
// Then open http://localhost:3000

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { getPool } from "./db.js";
import { normalizeReport, validateReportSchema, validateRawLlmJson } from "./src/lib/report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
// Shared pool of Groq API keys. Accepts GROQ_API_KEYS="k1,k2" (env), a single
// GROQ_API_KEY (env), or both from config.js. When the active key hits its rate
// limit (HTTP 429) or is rejected (401/403), the request is retried with the
// next key in the pool.
// Shared pool of Groq API keys. Accepts GROQ_API_KEYS="k1,k2" (env), a single
// GROQ_API_KEY (env), or both from config.js. When the active key hits its rate
// limit (HTTP 429) or is rejected (401/403), the request is retried with the
// next key in the pool. When EVERY Groq key fails, the request falls through to
// the xAI (Grok) key pool below.
const GROQ_KEYS = readKeys("GROQ");
const GROQ_MODEL = "openai/gpt-oss-120b";

// xAI (Grok) keys - the automatic fallback provider. xAI's API is OpenAI-
// compatible (https://api.x.ai/v1/chat/completions); its keys are set with
// XAI_API_KEYS="k1,k2" / XAI_API_KEY (env) or XAI_API_KEYS / XAI_API_KEY in
// config.js, and the model with XAI_MODEL (default grok-4.6).
const XAI_KEYS = readKeys("XAI");
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.6";
const XAI_URL = "https://api.x.ai/v1/chat/completions";

const AI_PROVIDER = process.env.AI_PROVIDER || "auto"; // clients can override per-request via body.provider
const LOCAL_BASE_URL = (process.env.LOCAL_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const LOCAL_MODEL = process.env.LOCAL_MODEL || "qwen3:14b";
// Phase 6: force {type:"json_object"} on every LOCAL-model call (set
// LOCAL_JSON_MODE=1 in the environment, or the client can request it per call
// with body.jsonMode). Only ever applied to the local provider — cloud models
// reject json_object on prose question turns. Intended for fine-tuned models
// trained to emit a single JSON object (see LOCAL_AI_PLAN.md).
const LOCAL_JSON_MODE = /^(1|true|on)$/i.test(process.env.LOCAL_JSON_MODE || "");
const UPSTREAM_TIMEOUT_MS = 180000;

// Per-user/per-IP token bucket on /api/chat (Phase 5.2): protects the Groq
// key pool from runaway usage. CHAT_RATE_MAX = burst size,
// CHAT_RATE_REFILL_MS = ms between refunded tokens.
const CHAT_RATE_MAX = Number(process.env.CHAT_RATE_MAX || 30);
const CHAT_RATE_REFILL_MS = Number(process.env.CHAT_RATE_REFILL_MS || 2000);
const chatBuckets = new Map();
setInterval(() => { // drop stale buckets so the map doesn't grow forever
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of chatBuckets) if (b.last < cutoff) chatBuckets.delete(k);
}, 60 * 1000).unref();

function allowChat(key) {
  const now = Date.now();
  let bucket = chatBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: CHAT_RATE_MAX, last: now };
    chatBuckets.set(key, bucket);
  }
  bucket.tokens = Math.min(CHAT_RATE_MAX, bucket.tokens + Math.floor((now - bucket.last) / CHAT_RATE_REFILL_MS));
  bucket.last = now;
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

// Index of the last key that worked; new requests start from it so a healthy
// key is preferred and exhausted keys are only hit when they're the only option.
let groqKeyCursor = 0;
let xaiKeyCursor = 0;

function readKeys(prefix) {
  const fromEnv = (process.env[`${prefix}_API_KEYS`] || process.env[`${prefix}_API_KEY`] || "")
    .split(",").map(k => k.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const cfg = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const arr = cfg.match(new RegExp(`${prefix}_API_KEYS\\s*:\\s*\\[([^\\]]*)\\]`));
    if (arr) {
      const keys = (arr[1].match(/["'][^"']+["']/g) || [])
        .map(k => k.replace(/["']/g, "").trim()).filter(Boolean);
      if (keys.length) return keys;
    }
    const single = cfg.match(new RegExp(`${prefix}_API_KEY\\s*:\\s*["']([^"']+)["']`));
    return single ? [single[1]] : [];
  } catch {
    return [];
  }
}

// ---- Reports list → CSV export (Phase 6) ----------------------------------
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Flattens each report row for monitoring spreadsheets: fixed metadata columns
// plus one column per top-level key found across all rows' report JSON.
// Arrays of objects become counts, arrays of scalars are joined with "; ",
// nested objects are stringified — so mixed templates still fit one sheet.
function reportsToCsv(rows) {
  const META = ["id", "owner_name", "template_id", "title", "status", "created_at", "updated_at"];
  const parsed = rows.map(r => {
    let rep = r.report;
    if (typeof rep === "string") { try { rep = JSON.parse(rep); } catch { rep = null; } }
    return { ...r, _rep: rep && typeof rep === "object" && !Array.isArray(rep) ? rep : {} };
  });
  const fieldSet = new Set();
  for (const r of parsed) for (const k of Object.keys(r._rep)) fieldSet.add(k);
  const fields = [...fieldSet].filter(k => k !== "photos"); // data URLs don't belong in a sheet
  const cell = (v) => {
    if (v == null) return "";
    if (Array.isArray(v)) {
      return v.length && typeof v[0] === "object" ? `${v.length} item(s)` : v.map(x => String(x?.name ?? x)).join("; ");
    }
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  };
  const lines = [[...META, ...fields].map(csvCell).join(",")];
  for (const r of parsed) {
    lines.push(
      [...META.map(m => r[m]), ...fields.map(f => cell(r._rep[f]))].map(csvCell).join(",")
    );
  }
  // UTF-8 BOM so Excel detects the encoding when the file is opened directly.
  return "\uFEFF" + lines.join("\r\n");
}

// ---- Template config management (Phase 8.3) ------------------------------
const VALID_FIELD_TYPES = ["text", "longform", "list", "beneficiaries", "person", "choice", "matrix", "captions"];

function validateTemplateConfig(tpl) {
  if (!tpl || typeof tpl !== "object" || Array.isArray(tpl)) return ["Template must be an object"];
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tpl.id || "")) {
    errors.push("id must be 2-64 chars: lowercase letters, digits and dashes");
  }
  if (!tpl.name || typeof tpl.name !== "string" || tpl.name.trim().length < 3) {
    errors.push("name is required (at least 3 characters)");
  }
  const fields = tpl.fields;
  if (!Array.isArray(fields) || !fields.length) {
    errors.push("fields must be a non-empty array");
  } else {
    const ids = new Set();
    fields.forEach((f, i) => {
      if (!f || typeof f.id !== "string" || !/^[\w-]+$/.test(f.id)) {
        errors.push(`fields[${i}].id is missing or invalid`);
      } else if (ids.has(f.id)) {
        errors.push(`fields[${i}].id "${f.id}" is duplicated`);
      } else {
        ids.add(f.id);
      }
      if (!f || !VALID_FIELD_TYPES.includes(f.type)) {
        errors.push(`fields[${i}].type must be one of: ${VALID_FIELD_TYPES.join(", ")}`);
      }
      if (Array.isArray(f?.itemFields)) f.itemFields.forEach((sf, j) => {
        if (!sf || !/^[\w-]+$/.test(sf.id || "")) errors.push(`fields[${i}].itemFields[${j}].id is invalid`);
      });
      if (Array.isArray(f?.categories)) f.categories.forEach((c, j) => {
        if (!c || !/^[\w-]+$/.test(c.id || "")) errors.push(`fields[${i}].categories[${j}].id is invalid`);
      });
    });
    // The first text field anchors raw-output validation — require one.
    if (!fields.some(f => f.type === "text")) errors.push("At least one text field is required");
  }
  // Default branding (Phase 8.4): optional server-relative image paths written
  // by the logo upload endpoint — never arbitrary URLs or traversal.
  for (const key of ["headerLogo", "footerLogo"]) {
    const v = tpl[key];
    if (v != null && v !== "" && !/^(templates\/[\w-]+\/[\w-]+\.(png|jpg|jpeg|webp|svg))$/.test(String(v))) {
      errors.push(`${key} must be a path under templates/<id>/ (png/jpg/webp/svg)`);
    }
  }
  return [...new Set(errors)];
}

// ---- Per-template default logos (Phase 8.4) -------------------------------
// Uploaded images are stored as files under templates/<id>/ and referenced
// from template.json (headerLogo/footerLogo), so every user who picks the
// template gets its branding without re-uploading.

const LOGO_KINDS = { header: "header-logo", footer: "footer-logo" };
const LOGO_MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg"
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // decoded size cap

function decodeDataUrl(dataUrl) {
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "dataUrl must be a base64 data URL (data:image/...;base64,...)" };
  const ext = LOGO_MIME_EXT[m[1].toLowerCase()];
  if (!ext) return { error: `Unsupported image type ${m[1]} (use PNG, JPEG, WebP or SVG)` };
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return { error: "Image is empty" };
  if (buf.length > MAX_LOGO_BYTES) return { error: `Image is too large (max ${Math.round(MAX_LOGO_BYTES / 1024)} KB after decoding)` };
  return { buf, ext };
}

function logoUrl(templateId, kind, ext) {
  return `templates/${templateId}/${LOGO_KINDS[kind]}${ext}`;
}

function saveTemplateFile(tpl) {
  const dir = path.join(__dirname, "templates", tpl.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(tpl, null, 2) + "\n");
  const indexPath = path.join(__dirname, "templates", "index.json");
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    index = { templates: [] };
  }
  if (!Array.isArray(index.templates)) index.templates = [];
  if (!index.templates.some(entry => (typeof entry === "string" ? entry : entry?.id) === tpl.id)) {
    index.templates.push(tpl.id);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- Request helpers (defined before any route so every route can use
  // them regardless of file order — routes run top-down per request) --------
  const SESSION_COOKIE = "aar_sid";
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  const parseCookies = (req) => {
    const out = {};
    for (const part of (req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  };

  // Resolves the logged-in user from the session cookie, or null.
  const getSessionUser = async (req) => {
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

  const setSessionCookie = (res, token, maxAgeMs) => {
    res.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  };

  const readBodyJson = async (req) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  function sendJson(status, obj) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  // Admin-only guard for template management endpoints.
  async function requireAdmin() {
    const user = await getSessionUser(req);
    if (!user) {
      sendJson(401, { error: { message: "Login required" } });
      return null;
    }
    if (user.role !== "admin") {
      sendJson(403, { error: { message: "Admin access required" } });
      return null;
    }
    return user;
  }

  // Audit trail (Phase 5.3): best-effort INSERT — logging must never break
  // or slow down the request it describes.
  async function writeAudit(user, action, { detail = null, provider = null, model = null } = {}) {
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
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Invalid username or password" } }));
        }
        user = { id: found.id, username: found.username, role: found.role };
      }
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))",
        [token, user.id, Math.floor(SESSION_TTL_MS / 1000)]
      );
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
    let body = {};
    if (req.method === "POST" || req.method === "PUT") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(400, { error: { message: "Invalid JSON body" } });
      }
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
      // excluded). Admins can list everyone's with ?all=1.
      if (req.method === "GET" && !reportId) {
        const all = url.searchParams.get("all") === "1" && user.role === "admin";
        // CSV download (Phase 6): ?format=csv exports the same view as a
        // spreadsheet — admins get everyone's rows with ?all=1, encoders
        // their own. Includes the flattened report JSON for monitoring.
        if (url.searchParams.get("format") === "csv") {
          const [rows] = await pool.query(
            `SELECT r.id, u.username AS owner_name, r.template_id, r.title, r.status,
                    r.report, r.created_at, r.updated_at
             FROM reports r LEFT JOIN users u ON u.id = r.owner
             ${all ? "" : "WHERE r.owner = ?"}
             ORDER BY r.updated_at DESC`,
            all ? [] : [user.id]
          );
          writeAudit(user, "report.export.csv", { detail: `${rows.length} row(s)${all ? " (all users)" : ""}` });
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="aar-reports-${new Date().toISOString().slice(0, 10)}.csv"`
          });
          return res.end(reportsToCsv(rows));
        }
        const [rows] = await pool.query(
          `SELECT r.id, r.owner, u.username AS owner_name, r.template_id, r.title, r.status, r.created_at, r.updated_at
           FROM reports r LEFT JOIN users u ON u.id = r.owner
           ${all ? "" : "WHERE r.owner = ?"}
           ORDER BY r.updated_at DESC`,
          all ? [] : [user.id]
        );
        return sendJson(200, rows);
      }

      // Create a new report.
      if (req.method === "POST") {
        if (!body.templateId) {
          return sendJson(400, { error: { message: "templateId is required" } });
        }
        const id = crypto.randomUUID();
        const checked = sanitizeReportPayload(body.report, body.templateId);
        if (checked.error) return sendJson(422, checked.error);
        await pool.query(
          "INSERT INTO reports (id, owner, template_id, title, status, conversation, report, photos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            user.id,
            String(body.templateId),
            body.title != null ? String(body.title) : null,
            body.status === "final" ? "final" : "draft",
            body.conversation != null ? JSON.stringify(body.conversation) : null,
            checked.report != null ? JSON.stringify(checked.report) : null,
            body.photos != null ? JSON.stringify(body.photos) : null
          ]
        );
        writeAudit(user, "report.create", { detail: `${id} — ${body.title || "untitled"} (${body.templateId})` });
        return sendJson(201, { id });
      }

      if (reportId) {
      // Non-admins may only touch their own reports.
      const canTouch = (row) => user.role === "admin" || row.owner === user.id;

      // Fetch one report (full row).
      if (req.method === "GET" && reportId) {
        const [rows] = await pool.query("SELECT * FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
        return sendJson(200, normalizeReportRow(rows[0]));
      }
      // Update mutable fields.
      if (req.method === "PUT" && reportId) {
        const [rows] = await pool.query("SELECT owner FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
        const sets = [];
        const params = [];
        if ("title" in body) { sets.push("title = ?"); params.push(body.title != null ? String(body.title) : null); }
        if ("status" in body) { sets.push("status = ?"); params.push(body.status === "final" ? "final" : "draft"); }
        if ("conversation" in body) { sets.push("conversation = ?"); params.push(body.conversation != null ? JSON.stringify(body.conversation) : null); }
        if ("report" in body) {
          const tplId = body.templateId || (await pool.query("SELECT template_id FROM reports WHERE id = ?", [reportId]))[0][0]?.template_id;
          const checked = sanitizeReportPayload(body.report, tplId);
          if (checked.error) return sendJson(422, checked.error);
          sets.push("report = ?");
          params.push(checked.report != null ? JSON.stringify(checked.report) : null);
        }
        if ("photos" in body) { sets.push("photos = ?"); params.push(body.photos != null ? JSON.stringify(body.photos) : null); }
          if (!sets.length) return sendJson(400, { error: { message: "Nothing to update" } });
          params.push(reportId);
          const [result] = await pool.query(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`, params);
          writeAudit(user, "report.update", { detail: reportId });
          return sendJson(200, { ok: true });
        }
        if (req.method === "DELETE" && reportId) {
          const [rows] = await pool.query("SELECT owner FROM reports WHERE id = ?", [reportId]);
          if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
          if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });
          await pool.query("DELETE FROM reports WHERE id = ?", [reportId]);
          writeAudit(user, "report.delete", { detail: reportId });
          return sendJson(200, { ok: true });
        }
      }

      return sendJson(405, { error: { message: "Method not allowed" } });
    } catch (e) {
      console.error("[reports]", e.message);
      return sendJson(500, { error: { message: "Database error: " + e.message } });
    }
  }

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    }

    const chatUser = await getSessionUser(req);
    const bucketKey = chatUser ? `u:${chatUser.id}` : `ip:${req.socket.remoteAddress}`;
    if (!allowChat(bucketKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Too many requests — please wait a moment before trying again" } }));
    }

    const provider = (body && body.provider) || AI_PROVIDER;
    const wantsStream = !!(body && body.stream);
    const messages = (body && body.messages) || [];
    const makeBody = (model) => JSON.stringify({
      model,
      max_tokens: (body && body.max_tokens) || 4000,
      temperature: 0.2,
      // Phase 6: opt-in strict JSON output, local model ONLY (fine-tuned
      // models that always answer with a single JSON object). Cloud providers
      // never get response_format — json_object breaks their prose questions.
      // Enabled via env LOCAL_JSON_MODE=1 or the client sending jsonMode:true.
      response_format: provider === "local" && (body?.jsonMode === true || LOCAL_JSON_MODE)
        ? { type: "json_object" }
        : undefined,
      stream: wantsStream || undefined, // omitted when false
      messages
    });

    // One candidate per key: the proxy tries Groq keys first (each in turn,
    // moving on when a key is rate-limited / rejected) and falls through to the
    // xAI (Grok) key pool when EVERY Groq key fails. A single local candidate
    // is used for AI_PROVIDER=local.
    let groqCandidates = [];
    let xaiCandidates = [];
    let localCandidates = [];
    if (provider === "local") {
      if (!LOCAL_MODEL) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "LOCAL_MODEL is not set on the server" } }));
      }
      localCandidates = [{
        url: LOCAL_BASE_URL + "/chat/completions",
        body: makeBody(LOCAL_MODEL),
        headers: { "Content-Type": "application/json" },
        label: "local model",
        model: LOCAL_MODEL
      }];
      groqCandidates = localCandidates;
    } else {
      // Auto (default): try the local model first when one is configured,
      // then fall back to the Groq/xAI key pools below.
      if (provider === "auto" && LOCAL_MODEL) {
        localCandidates = [{
          url: LOCAL_BASE_URL + "/chat/completions",
          body: makeBody(LOCAL_MODEL),
          headers: { "Content-Type": "application/json" },
          label: "local model",
          model: LOCAL_MODEL
        }];
      }
      if (!GROQ_KEYS.length && !XAI_KEYS.length && !localCandidates.length) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "GROQ_API_KEY / GROQ_API_KEYS (or XAI_API_KEY / XAI_API_KEYS) is not set (set them in the environment or config.js)" } }));
      }
      groqCandidates = GROQ_KEYS.map(key => ({
        url: "https://api.groq.com/openai/v1/chat/completions",
        body: makeBody(GROQ_MODEL),
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        label: "Groq",
        model: GROQ_MODEL
      }));
      xaiCandidates = XAI_KEYS.map(key => ({
        url: XAI_URL,
        body: makeBody(XAI_MODEL),
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        label: "xAI",
        model: XAI_MODEL
      }));
    }

    // Abort the upstream request if the client disconnects; add a hard timeout
    // for buffered (non-streaming) requests only.
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const timer = wantsStream ? null : setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      let upRes = null;
      let chosenCand = null; // the candidate that ultimately answered
      let lastErr = null;
      let lastKeyErr = null; // { status, text } of the last rate-limited/rejected key
      let allKeyIssues = true;

      // Phase order: auto → local model first, then Groq keys (starting from
      // the last key that worked), then xAI (Grok) keys - only reached when
      // every earlier option is unreachable/exhausted.
      const phases = provider === "local"
        ? [{ candidates: groqCandidates, cursor: () => 0, setCursor: () => {} }]
        : [
            ...(provider === "auto"
              ? [{ candidates: localCandidates, cursor: () => 0, setCursor: () => {} }]
              : []),
            { candidates: groqCandidates, cursor: () => groqKeyCursor, setCursor: (i) => { groqKeyCursor = i; } },
            { candidates: xaiCandidates, cursor: () => xaiKeyCursor, setCursor: (i) => { xaiKeyCursor = i; } }
          ];

      for (const phase of phases) {
        const list = phase.candidates;
        if (!list.length) continue;
        const start = phase.cursor() % list.length;
        for (let i = 0; i < list.length; i++) {
          const idx = (start + i) % list.length;
          const cand = list[idx];
          try {
            upRes = await fetch(cand.url, {
              method: "POST",
              headers: cand.headers,
              body: cand.body,
              signal: ctrl.signal
            });
          } catch (e) {
            lastErr = e;
            if (e.name === "AbortError") throw e; // client disconnected / timeout
            console.warn(`[proxy] ${cand.label} candidate ${idx + 1}/${list.length} failed: ${e.message}`);
            continue;
          }
          // Key-related failures (rate limit / invalid key) → try the next key.
          // In auto mode a failed/unreachable LOCAL model is also non-terminal:
          // it just means "move on to the cloud pools".
          const fromLocal = cand.label === "local model";
          const keyIssue = provider !== "local" && !fromLocal && [401, 403, 429].includes(upRes.status);
          if (!upRes.ok && (keyIssue || (fromLocal && provider === "auto"))) {
            await upRes.text().catch(() => ""); // drain so the connection can be reused
            if (keyIssue) {
              lastKeyErr = { status: upRes.status, text: "" };
              console.warn(`[proxy] ${cand.label} key ${idx + 1}/${list.length} returned ${upRes.status}; trying next key`);
            } else {
              lastErr = new Error(`${cand.label} returned ${upRes.status}`);
              console.warn(`[proxy] ${cand.label} returned ${upRes.status}; falling back to next provider`);
            }
            upRes = null;
            continue;
          }
          allKeyIssues = false;
          if (upRes.ok) {
            phase.setCursor(idx); // remember the key that worked
            chosenCand = cand;
          }
          break; // success, or a non-key error to relay as-is
        }
        // Move to the next provider only if this phase was fully exhausted
        // (every key rate-limited/rejected or unreachable).
        if (upRes) break;
      }
      // Every key was rejected / rate-limited — advance both cursors so the
      // next request starts from a different key, then relay the last error.
      if (!upRes && allKeyIssues) {
        if (groqCandidates.length > 1) groqKeyCursor = (groqKeyCursor + 1) % groqCandidates.length;
        if (xaiCandidates.length > 1) xaiKeyCursor = (xaiKeyCursor + 1) % xaiCandidates.length;
      }
      if (!upRes && lastKeyErr) {
        res.writeHead(lastKeyErr.status, { "Content-Type": "application/json" });
        return res.end(lastKeyErr.text || JSON.stringify({ error: { message: "All API keys failed (last: " + lastKeyErr.status + ")" } }));
      }
      if (!upRes) throw lastErr || new Error("No upstream candidates");

      // Audit: which provider/model answered this chat (5.3). Best-effort.
      writeAudit(chatUser, "chat", {
        detail: provider,
        provider: chosenCand ? chosenCand.label : null,
        model: chosenCand ? chosenCand.model : null
      });

      if (wantsStream && upRes.body) {
        res.writeHead(upRes.status, {
          "Content-Type": upRes.headers.get("content-type") || "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        for await (const chunk of upRes.body) res.write(chunk);
        return res.end();
      }

      const data = await upRes.json();
      res.writeHead(upRes.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (err) {
      if (res.writableEnded) return;
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Upstream request failed: " + (err.message || "unknown") } }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Static files. Serves the Vite build output from dist/ when it exists,
  // falling back to the project root (for config.js and other root assets).
  const staticRoot = path.join(__dirname, "dist");
  let filePath = path.join(
    fs.existsSync(staticRoot) ? staticRoot : __dirname,
    url.pathname === "/" ? "index.html" : url.pathname
  );
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err && fs.existsSync(staticRoot)) {
      // Retry from the project root before giving up.
      const rootPath = path.join(__dirname, url.pathname);
      if (rootPath.startsWith(__dirname) && fs.existsSync(rootPath)) {
        return fs.readFile(rootPath, (err2, data2) => {
          if (err2) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("Not found");
          }
          res.writeHead(200, { "Content-Type": MIME[path.extname(rootPath).toLowerCase()] || "application/octet-stream" });
          res.end(data2);
        });
      }
      // SPA fallback: serve the built index.html for client-side routes.
      const indexPath = path.join(staticRoot, "index.html");
      if (!url.pathname.startsWith("/api") && fs.existsSync(indexPath)) {
        return fs.readFile(indexPath, (err3, data3) => {
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(data3);
        });
      }
    }
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AAR Generator running at http://localhost:${PORT} (AI provider: ${AI_PROVIDER})`);
});
