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

// AI provider modes (clients can override per-request via body.provider):
//   "groq"        → cloud only (Groq keys, then xAI keys)
//   "local"       → local model only, errors when unreachable
//   "auto"        → local model first, cloud fallback (for fine-tune iteration)
//   "contingency" → cloud first, LOCAL MODEL AS LAST RESORT. Use this in
//                   production: normal operation runs on Groq, and when every
//                   key is rejected/out of credit the office keeps working on
//                   the offline model instead of being blocked. See
//                   LOCAL_AI_CONTINGENCY.md.
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

// ---- Contingency: cloud credit-exhaustion circuit breaker ------------------
// When a cloud provider answers with "you are out of credit/quota" rather than
// a per-key rate limit, retrying the next key is pointless. We open a breaker
// for CONTINGENCY_COOLDOWN_MS and route straight to the local model, so a
// regional office keeps producing reports when the token budget runs out.
const CONTINGENCY_COOLDOWN_MS = Number(process.env.CONTINGENCY_COOLDOWN_MS || 15 * 60 * 1000);
const CONTINGENCY_ENABLED = !/^(0|false|off)$/i.test(process.env.CONTINGENCY_ENABLED || "1");
// Signals that a key is out of money, not merely throttled. Groq/xAI return 402
// for exhausted credit and 429 with an insufficient_quota-style body when the
// free tier is spent.
const CREDIT_EXHAUSTED_RE = /insufficient[_ ]?quota|exceeded your current quota|quota exceeded|billing|out of credit|no credit|payment required|credit balance|spending limit|free tier/i;
// Breakers are tracked per provider: Groq running out of credit says nothing
// about xAI's balance, so only the broke provider gets skipped.
const CLOUD_PROVIDERS = ["groq", "xai"];
const cloudBreakerUntil = { groq: 0, xai: 0 };   // epoch ms; > now = skip this provider
const cloudBreakerReason = { groq: null, xai: null };
let cloudBreakerTrips = 0;

const cloudBreakerOpen = (providerKey) =>
  CONTINGENCY_ENABLED && !!providerKey && Date.now() < (cloudBreakerUntil[providerKey] || 0);

function noteCloudCreditFailure(providerKey, status, text) {
  if (!CONTINGENCY_ENABLED || !providerKey) return false;
  if (status !== 402 && !(status === 429 && CREDIT_EXHAUSTED_RE.test(text || ""))) return false;
  cloudBreakerUntil[providerKey] = Date.now() + CONTINGENCY_COOLDOWN_MS;
  cloudBreakerReason[providerKey] = status === 402 ? "payment required (402)" : "quota/credit exhausted (429)";
  cloudBreakerTrips++;
  console.warn(
    `[proxy] ${providerKey} credit exhausted — ${cloudBreakerReason[providerKey]}. ` +
    `Skipping it for ${Math.round(CONTINGENCY_COOLDOWN_MS / 60000)} min; ` +
    `falling through to the local contingency model (${LOCAL_MODEL}).`
  );
  return true;
}

const cloudBreakerState = () => ({
  enabled: CONTINGENCY_ENABLED,
  cooldownSeconds: Math.round(CONTINGENCY_COOLDOWN_MS / 1000),
  trips: cloudBreakerTrips,
  providers: Object.fromEntries(CLOUD_PROVIDERS.map(p => [
    p,
    {
      open: cloudBreakerOpen(p),
      reason: cloudBreakerReason[p],
      resumesInSeconds: cloudBreakerOpen(p)
        ? Math.round((cloudBreakerUntil[p] - Date.now()) / 1000)
        : 0
    }
  ]))
});

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

// ---- Auth throttling (P0) --------------------------------------------------
// /api/chat was rate-limited but the login endpoint was not, which made it the
// softest target on a public HTTPS host. Fixed-window counters keyed on both
// the client IP and the attempted username, so neither a single account nor a
// single source can be hammered. A successful login clears both.
//
// The two limits are deliberately different. A whole regional office sits
// behind one NAT address, so a tight per-IP limit would let one person's typos
// lock out every colleague for the whole window. The per-username limit is
// therefore tight (protects the account) and the per-IP limit is loose
// (protects the service).
const AUTH_RATE_MAX = Number(process.env.AUTH_RATE_MAX || 10);          // per username
const AUTH_RATE_MAX_IP = Number(process.env.AUTH_RATE_MAX_IP || 60);    // per IP
const AUTH_RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000);
const authBuckets = new Map();

function authBucket(key) {
  const now = Date.now();
  let b = authBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS };
    authBuckets.set(key, b);
  }
  return b;
}
const authLimitFor = (key) => (key.startsWith("ip:") ? AUTH_RATE_MAX_IP : AUTH_RATE_MAX);
const authBlocked = (key) => authBucket(key).count >= authLimitFor(key);
const authPenalize = (key) => { authBucket(key).count++; };
const authForgive = (key) => { authBuckets.delete(key); };

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of authBuckets) if (now >= b.resetAt) authBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ---- Expired-session sweep (P0) -------------------------------------------
// Sessions were only deleted on logout or password reset, while expiry was
// checked at read time — so the table grew forever. Sweep hourly.
const sweepExpiredSessions = () => {
  getPool()
    .query("DELETE FROM sessions WHERE expires_at < NOW()")
    .then(([r]) => { if (r.affectedRows) console.log(`[sessions] swept ${r.affectedRows} expired session(s)`); })
    .catch(() => { /* DB not reachable yet — the next tick retries */ });
};
setInterval(sweepExpiredSessions, 60 * 60 * 1000).unref();

// ---- Request hardening (P0) ------------------------------------------------
// Every body reader was unbounded; one oversized POST could OOM the process and
// take the whole office offline. 32 MB covers the largest legitimate payload
// (a report draft carrying several compressed photo data URLs).
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 32 * 1024 * 1024);
// Secure cookies + HSTS only when we know we're behind TLS, so local XAMPP over
// plain http keeps working. nginx terminates TLS on the VPS (DEPLOYMENT.md).
const COOKIE_SECURE = /^(1|true|on)$/i.test(process.env.COOKIE_SECURE || "")
  || process.env.NODE_ENV === "production";
// CSP ships report-only by default because the app uses inline styles and the
// PDF renderer writes an inline-scripted print window. Set CSP_ENFORCE=1 once
// the report-only console is clean.
const CSP_ENFORCE = /^(1|true|on)$/i.test(process.env.CSP_ENFORCE || "");
const CSP_POLICY = process.env.CSP_POLICY || [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' http://localhost:11434 http://127.0.0.1:11434 https://api.groq.com https://api.x.ai https://openrouter.ai",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join("; ");

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
  const META = ["id", "owner_name", "template_id", "title", "control_no", "status", "created_at", "updated_at"];
  const parsed = rows.map(r => {
    let rep = r.report;
    if (typeof rep === "string") { try { rep = JSON.parse(rep); } catch { rep = null; } }
    return { ...r, _rep: rep && typeof rep === "object" && !Array.isArray(rep) ? rep : {} };
  });
  const fieldSet = new Set();
  for (const r of parsed) for (const k of Object.keys(r._rep)) fieldSet.add(k);
  // "photos" holds base64 data URLs, which don't belong in a sheet. A report
  // field whose id matches a META column (e.g. "title") would otherwise produce
  // a duplicate header — Excel can't tell the two apart and lookups break — so
  // those get a "report_" prefix to keep every column name unique.
  const fields = [...fieldSet]
    .filter(k => k !== "photos")
    .map(k => ({ key: k, header: META.includes(k) ? `report_${k}` : k }));
  const cell = (v) => {
    if (v == null) return "";
    if (Array.isArray(v)) {
      return v.length && typeof v[0] === "object" ? `${v.length} item(s)` : v.map(x => String(x?.name ?? x)).join("; ");
    }
    if (typeof v === "object") return JSON.stringify(v);
    return v;
  };
  const lines = [[...META, ...fields.map(f => f.header)].map(csvCell).join(",")];
  for (const r of parsed) {
    lines.push(
      [...META.map(m => r[m]), ...fields.map(f => cell(r._rep[f.key]))].map(csvCell).join(",")
    );
  }
  // UTF-8 BOM so Excel detects the encoding when the file is opened directly.
  return "\uFEFF" + lines.join("\r\n");
}

// ---- Control numbers (plan 3.2) -------------------------------------------
// Templates opt in by marking a field with "auto": "controlNumber" and giving
// the template a controlPrefix. The number is issued by the server so two
// encoders can never produce the same one, and it is stored in
// reports.control_no (UNIQUE) rather than buried in the report JSON.
const pad2 = (n) => String(n).padStart(2, "0");

// Reserves the next sequence number for (template, year). LAST_INSERT_ID(expr)
// is per-connection, so both statements must run on the same pooled connection
// to be atomic under concurrent creates.
async function reserveControlSeq(pool, templateId, year) {
  const conn = await pool.getConnection();
  try {
    await conn.query(
      `INSERT INTO control_sequences (template_id, year, last_seq)
       VALUES (?, ?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1)`,
      [templateId, year]
    );
    const [[row]] = await conn.query("SELECT LAST_INSERT_ID() AS seq");
    return Number(row?.seq) || 1;
  } finally {
    conn.release();
  }
}

// "eLGU-R2" + 157 → "eLGU-R2-12-04-2025-S157"
function formatControlNo(prefix, seq, when = new Date()) {
  const stamp = `${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}-${when.getFullYear()}`;
  return `${prefix}-${stamp}-S${seq}`;
}

function readTemplateConfig(templateId) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "templates", String(templateId), "template.json"), "utf8")
    );
  } catch {
    return null;
  }
}

// Returns the control-number field when the template is set up for automatic
// numbering, otherwise null (most templates have no control number at all).
function controlNumberField(tplCfg) {
  const field = (tplCfg?.fields || []).find(f => f && f.auto === "controlNumber");
  return field && tplCfg.controlPrefix ? field : null;
}

// ---- Optimistic concurrency (plan 2.7) ------------------------------------
// Autosave used to be last-write-wins: two tabs (or a laptop and a desktop)
// silently overwrote each other, and a queued retry could resurrect a payload
// captured up to a minute earlier. Clients now send the version they loaded and
// a mismatch is rejected with 409 so the user chooses which copy to keep.
//
// reports.version is a monotonic INT rather than updated_at, because
// updated_at is a one-second TIMESTAMP: two saves inside the same second would
// look identical and the check would pass when it should not.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses the client's expected version. Returns undefined when the client
// didn't send one (older client, or a path that doesn't track versions) so the
// caller can skip the check instead of rejecting the write.
function expectedVersion(body) {
  if (!body || body.version == null) return undefined;
  const n = Number(body.version);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

// ---- Report photos (plan 2.6) ----------------------------------------------
// Photos live in report_photos instead of inside the reports row, so a draft
// carrying 1.5-3 MB of base64 no longer rides along with every report read and
// every autosave. The client sends data URLs; they are decoded and stored as
// bytes so the DB no longer pays the ~33% base64 overhead either.
const MAX_REPORT_PHOTOS = Number(process.env.MAX_REPORT_PHOTOS || 10);
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES || 3 * 1024 * 1024);
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

// Returns { photos: [{ mime, bytes, caption }] } or { error }.
function parsePhotoPayload(items) {
  if (!Array.isArray(items)) return { photos: [] };
  if (items.length > MAX_REPORT_PHOTOS) {
    return { error: { message: `A report can hold at most ${MAX_REPORT_PHOTOS} photos` } };
  }
  const photos = [];
  for (const item of items) {
    const dataUrl = typeof item === "string" ? item : item?.dataUrl;
    const caption = item && typeof item === "object" && item.caption != null
      ? String(item.caption).slice(0, 255)
      : null;
    const m = DATA_URL_RE.exec(String(dataUrl || ""));
    if (!m) return { error: { message: "Each photo must be a base64 image data URL" } };
    const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
    if (bytes.length > MAX_PHOTO_BYTES) {
      return { error: { message: `A photo exceeds the ${Math.round(MAX_PHOTO_BYTES / 1048576)} MB limit` } };
    }
    photos.push({ mime: m[1].toLowerCase(), bytes, caption });
  }
  return { photos };
}

// Replaces a report's whole photo set in one transaction. Replace-all keeps the
// client simple (it just sends the current array) and preserves ordering, so
// drag-to-reorder works later without a schema change.
async function replaceReportPhotos(pool, reportId, items) {
  const parsed = parsePhotoPayload(items);
  if (parsed.error) return parsed;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM report_photos WHERE report_id = ?", [reportId]);
    for (let i = 0; i < parsed.photos.length; i++) {
      const p = parsed.photos[i];
      await conn.query(
        "INSERT INTO report_photos (report_id, seq, mime, bytes, caption) VALUES (?, ?, ?, ?, ?)",
        [reportId, i, p.mime, p.bytes, p.caption]
      );
    }
    // Clear the legacy column so the two stores can never disagree.
    await conn.query("UPDATE reports SET photos = NULL WHERE id = ?", [reportId]);
    await conn.commit();
    return { count: parsed.photos.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Reads a report's photos as data URLs, falling back to the legacy
// reports.photos column so reports saved before the migration keep working
// until scripts/migrate-photos.js has moved them.
async function loadReportPhotos(pool, reportId) {
  const [rows] = await pool.query(
    "SELECT seq, mime, bytes, caption FROM report_photos WHERE report_id = ? ORDER BY seq",
    [reportId]
  );
  if (rows.length) {
    return rows.map(r => ({
      dataUrl: `data:${r.mime};base64,${Buffer.from(r.bytes).toString("base64")}`,
      caption: r.caption || ""
    }));
  }
  const [legacy] = await pool.query("SELECT photos FROM reports WHERE id = ?", [reportId]);
  let arr = legacy[0]?.photos;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = null; } }
  return Array.isArray(arr)
    ? arr.filter(u => typeof u === "string").map(u => ({ dataUrl: u, caption: "" }))
    : [];
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
      // "auto" marks a field the SERVER fills (currently only the control
      // number) — it is excluded from chat collection and the model's schema.
      if (f?.auto != null && f.auto !== "controlNumber") {
        errors.push(`fields[${i}].auto must be "controlNumber" when set`);
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
  // Automatic control numbers (plan 3.2): the prefix is the leading segment of
  // the issued number, e.g. "eLGU-R2" → "eLGU-R2-12-04-2025-S157".
  const wantsAutoControlNo = (tpl.fields || []).some(f => f?.auto === "controlNumber");
  if (tpl.controlPrefix != null && String(tpl.controlPrefix).trim() !== "") {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/.test(String(tpl.controlPrefix).trim())) {
      errors.push("controlPrefix must be 1-40 characters (letters, digits, spaces, . _ - /)");
    }
  }
  if (wantsAutoControlNo && !String(tpl.controlPrefix || "").trim()) {
    errors.push('a field marked auto:"controlNumber" requires controlPrefix (e.g. "eLGU-R2")');
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

  // Baseline security headers (P0). Applied to every response before any route
  // runs, so a newly added endpoint is covered by default. Mirrored in nginx in
  // DEPLOYMENT.md because the Node port can also be reached directly.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader(CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", CSP_POLICY);

  // Refuse an oversized upload before routing, so a huge POST never reaches a
  // route (or its memory) at all.
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return sendJson(413, {
      error: { message: `Request body too large (limit ${Math.round(MAX_BODY_BYTES / 1048576)} MB)` }
    });
  }

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
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax;` +
      (COOKIE_SECURE ? " Secure;" : "") +
      ` Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  };

  // Bounded body reader (P0). Memory is capped at maxBytes: once the limit is
  // passed the reader keeps draining the socket (so the connection stays
  // healthy) but stops buffering, and returns null. Honest clients are already
  // refused with a 413 by the Content-Length check at the top of the handler.
  const readBodyRaw = async (req, maxBytes = MAX_BODY_BYTES) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && declared > maxBytes) return null;
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
      if (overflow) continue; // keep draining, stop buffering
      size += chunk.length;
      if (size > maxBytes) { overflow = true; chunks.length = 0; continue; }
      chunks.push(chunk);
    }
    if (overflow) {
      console.warn(`[server] request body exceeded ${Math.round(maxBytes / 1048576)} MB; discarded`);
      return null;
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const readBodyJson = async (req, maxBytes = MAX_BODY_BYTES) => {
    const raw = await readBodyRaw(req, maxBytes);
    if (raw === null) return null;
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
      // excluded). Admins can list everyone's with ?all=1.
      if (req.method === "GET" && !reportId) {
        const all = url.searchParams.get("all") === "1" && user.role === "admin";
        // CSV download (Phase 6): ?format=csv exports the same view as a
        // spreadsheet — admins get everyone's rows with ?all=1, encoders
        // their own. Includes the flattened report JSON for monitoring.
        if (url.searchParams.get("format") === "csv") {
          const [rows] = await pool.query(
            `SELECT r.id, u.username AS owner_name, r.template_id, r.title, r.control_no, r.status,
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
          `SELECT r.id, r.owner, u.username AS owner_name, r.template_id, r.title, r.control_no, r.status,
                  r.version,
                  (SELECT COUNT(*) FROM report_photos p WHERE p.report_id = r.id) AS photos_count,
                  r.created_at, r.updated_at
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
              body.status === "final" ? "final" : "draft",
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

      // Photos (plan 2.6): fetched separately from the report row so a draft's
      // megabytes of base64 no longer ride along with every read.
      if (photoSub && reportId) {
        const [rows] = await pool.query("SELECT owner, photos FROM reports WHERE id = ?", [reportId]);
        if (!rows.length) return sendJson(404, { error: { message: "Report not found" } });
        if (!canTouch(rows[0])) return sendJson(403, { error: { message: "Not your report" } });

        if (req.method === "GET") {
          return sendJson(200, { photos: await loadReportPhotos(pool, reportId) });
        }
        if (req.method === "PUT") {
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
        const [rows] = await pool.query("SELECT owner, version FROM reports WHERE id = ?", [reportId]);
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

  // AI provider status (admin). Answers the contingency question directly:
  // which providers are configured, is the local fallback actually reachable
  // right now, and has the credit breaker tripped? See LOCAL_AI_CONTINGENCY.md.
  if (url.pathname === "/api/ai/status") {
    if (req.method !== "GET") return sendJson(405, { error: { message: "Method not allowed" } });
    const admin = await requireAdmin();
    if (!admin) return;

    // Short probe — an unreachable local server must not hang the admin panel.
    const local = {
      configured: !!LOCAL_MODEL, model: LOCAL_MODEL, baseUrl: LOCAL_BASE_URL,
      reachable: false, modelPresent: null, models: [], error: null
    };
    try {
      const probe = await fetch(`${LOCAL_BASE_URL}/models`, { signal: AbortSignal.timeout(2500) });
      if (probe.ok) {
        const data = await probe.json().catch(() => null);
        local.reachable = true;
        local.models = Array.isArray(data?.data)
          ? data.data.map(m => m.id).filter(Boolean).slice(0, 50)
          : [];
        local.modelPresent = local.models.length ? local.models.includes(LOCAL_MODEL) : null;
      } else {
        local.error = `HTTP ${probe.status}`;
      }
    } catch (e) {
      local.error = (e.name === "TimeoutError" || e.name === "AbortError")
        ? "timed out after 2.5s"
        : (e.message || "unreachable");
    }

    // The fallback order the server would actually attempt right now, with
    // providers that are out of credit omitted.
    const chain = [];
    const pushCloud = () => {
      if (GROQ_KEYS.length && !cloudBreakerOpen("groq")) chain.push(`groq:${GROQ_MODEL}`);
      if (XAI_KEYS.length && !cloudBreakerOpen("xai")) chain.push(`xai:${XAI_MODEL}`);
    };
    const pushLocal = () => { if (LOCAL_MODEL) chain.push(`local:${LOCAL_MODEL}`); };
    if (AI_PROVIDER === "local") pushLocal();
    else if (AI_PROVIDER === "auto") { pushLocal(); pushCloud(); }
    else if (AI_PROVIDER === "contingency") { pushCloud(); pushLocal(); }
    else pushCloud();

    return sendJson(200, {
      providerMode: AI_PROVIDER,
      modes: ["contingency", "auto", "local", "groq"],
      cloud: {
        groq: { keys: GROQ_KEYS.length, model: GROQ_MODEL },
        xai: { keys: XAI_KEYS.length, model: XAI_MODEL }
      },
      local,
      breaker: cloudBreakerState(),
      effectiveChain: chain,
      // True when the offline path is genuinely usable, not merely configured.
      contingencyReady: !!(LOCAL_MODEL && local.reachable)
    });
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

    // Candidate pools. The local model is built once and then placed in the
    // chain according to the provider mode (see the `phases` list below):
    //   local       → local only
    //   auto        → local first, cloud fallback
    //   contingency → cloud first, LOCAL LAST RESORT
    const localCandidate = LOCAL_MODEL ? {
      url: LOCAL_BASE_URL + "/chat/completions",
      body: makeBody(LOCAL_MODEL),
      headers: { "Content-Type": "application/json" },
      label: "local model",
      model: LOCAL_MODEL
    } : null;

    let groqCandidates = [];
    let xaiCandidates = [];
    let localCandidates = [];
    if (provider === "local") {
      if (!localCandidate) {
        return sendJson(500, { error: { message: "LOCAL_MODEL is not set on the server" } });
      }
      localCandidates = [localCandidate];
      groqCandidates = localCandidates; // the single-phase path below reads this
    } else {
      if ((provider === "auto" || provider === "contingency") && localCandidate) {
        localCandidates = [localCandidate];
      }
      if (!GROQ_KEYS.length && !XAI_KEYS.length && !localCandidates.length) {
        return sendJson(500, {
          error: {
            message: "No AI provider configured. Set GROQ_API_KEY / GROQ_API_KEYS " +
              "(or XAI_API_KEY / XAI_API_KEYS) in the environment or config.js, or install a " +
              "local model — see LOCAL_AI_CONTINGENCY.md."
          }
        });
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

      // Phase order:
      //   local       → local model only
      //   auto        → local first, then Groq keys, then xAI keys
      //   contingency → Groq keys, then xAI keys, then LOCAL AS LAST RESORT
      //                 (a provider whose credit breaker is open is skipped)
      //   groq/other  → cloud pools only
      const localPhase = { candidates: localCandidates, cursor: () => 0, setCursor: () => {} };
      const cloudPhases = [
        { candidates: groqCandidates, cursor: () => groqKeyCursor, setCursor: (i) => { groqKeyCursor = i; }, providerKey: "groq" },
        { candidates: xaiCandidates, cursor: () => xaiKeyCursor, setCursor: (i) => { xaiKeyCursor = i; }, providerKey: "xai" }
      ];

      let phases;
      if (provider === "local") {
        phases = [localPhase];
      } else if (provider === "auto") {
        phases = [localPhase, ...cloudPhases];
      } else if (provider === "contingency") {
        phases = [...cloudPhases, localPhase];
      } else {
        phases = cloudPhases;
      }

      // Nothing left to try: contingency is configured but no local model is
      // installed and every cloud provider is out of credit. Say so plainly
      // instead of failing with a generic upstream error.
      if (provider === "contingency" && !localCandidates.length
          && CLOUD_PROVIDERS.every(p => cloudBreakerOpen(p))) {
        return sendJson(503, {
          error: {
            message: "Cloud AI credit is exhausted and no local contingency model is available. " +
              "Start a local model and set LOCAL_MODEL (see LOCAL_AI_CONTINGENCY.md)."
          }
        });
      }

      for (const phase of phases) {
        const list = phase.candidates;
        if (!list.length) continue;
        // Skip a cloud provider whose credit breaker is open — including one
        // that tripped earlier in this very request.
        if (phase.providerKey && cloudBreakerOpen(phase.providerKey)) {
          console.warn(`[proxy] skipping ${phase.providerKey} (credit breaker open); next phase`);
          continue;
        }
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
          // Provider-level failure → try the next key, then the next phase.
          // For a CLOUD provider any 4xx/5xx counts: the request body is built
          // here, so a 400 means the provider rejected our key/model/parameters
          // rather than the client sending something malformed. Treating those
          // as terminal (as this proxy used to) meant a provider that answers
          // "bad key" with a 400 instead of a 401 would hand the user a raw
          // upstream error and the contingency would never engage.
          // A failed or unreachable LOCAL model is non-terminal in auto and
          // contingency mode too: it just means "move to the next phase".
          const fromLocal = cand.label === "local model";
          const keyIssue = provider !== "local" && !fromLocal && upRes.status >= 400;
          const localSkippable = fromLocal && (provider === "auto" || provider === "contingency");
          if (!upRes.ok && (keyIssue || localSkippable)) {
            const errText = await upRes.text().catch(() => ""); // drain so the connection can be reused
            if (keyIssue) {
              // Out of credit rather than merely throttled → trip this
              // provider's breaker and abandon its remaining keys. The outer
              // loop then skips the rest of the cloud phases and lands on the
              // local contingency model.
              if (noteCloudCreditFailure(phase.providerKey, upRes.status, errText)) {
                upRes = null;
                break;
              }
              lastKeyErr = { status: upRes.status, text: errText.slice(0, 500) };
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
