// Control numbers (plan 3.2).
// Templates opt in by marking a field with "auto": "controlNumber" and giving the
// template a controlPrefix. The number is issued by the server so two encoders
// can never produce the same one.


import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");

// ---- Control numbers (plan 3.2) -------------------------------------------
// Templates opt in by marking a field with "auto": "controlNumber" and giving
// the template a controlPrefix. The number is issued by the server so two
// encoders can never produce the same one, and it is stored in
// reports.control_no (UNIQUE) rather than buried in the report JSON.
export const pad2 = (n) => String(n).padStart(2, "0");

// Reserves the next sequence number for (template, year). LAST_INSERT_ID(expr)
// is per-connection, so both statements must run on the same pooled connection
// to be atomic under concurrent creates.
export async function reserveControlSeq(pool, templateId, year) {
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
export function formatControlNo(prefix, seq, when = new Date()) {
  const stamp = `${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}-${when.getFullYear()}`;
  return `${prefix}-${stamp}-S${seq}`;
}

export function readTemplateConfig(templateId) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(rootDir, "templates", String(templateId), "template.json"), "utf8")
    );
  } catch {
    return null;
  }
}

// Returns the control-number field when the template is set up for automatic
// numbering, otherwise null (most templates have no control number at all).
export function controlNumberField(tplCfg) {
  const field = (tplCfg?.fields || []).find(f => f && f.auto === "controlNumber");
  return field && tplCfg.controlPrefix ? field : null;
}
