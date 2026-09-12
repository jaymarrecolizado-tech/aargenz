// Template config validation and per-template logo files.
// Adding a DICT project means dropping a folder in templates/ — this is what
// keeps that folder honest.


import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");

// ---- Template config management (Phase 8.3) ------------------------------
export const VALID_FIELD_TYPES = ["text", "longform", "list", "beneficiaries", "person", "choice", "matrix", "captions"];

export function validateTemplateConfig(tpl) {
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

export const LOGO_KINDS = { header: "header-logo", footer: "footer-logo" };
export const LOGO_MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg"
};
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // decoded size cap

export function decodeDataUrl(dataUrl) {
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "dataUrl must be a base64 data URL (data:image/...;base64,...)" };
  const ext = LOGO_MIME_EXT[m[1].toLowerCase()];
  if (!ext) return { error: `Unsupported image type ${m[1]} (use PNG, JPEG, WebP or SVG)` };
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return { error: "Image is empty" };
  if (buf.length > MAX_LOGO_BYTES) return { error: `Image is too large (max ${Math.round(MAX_LOGO_BYTES / 1024)} KB after decoding)` };
  return { buf, ext };
}

export function logoUrl(templateId, kind, ext) {
  return `templates/${templateId}/${LOGO_KINDS[kind]}${ext}`;
}

export function saveTemplateFile(tpl) {
  const dir = path.join(rootDir, "templates", tpl.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(tpl, null, 2) + "\n");
  const indexPath = path.join(rootDir, "templates", "index.json");
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
