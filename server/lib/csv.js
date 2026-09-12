// Reports list -> CSV export.
// Flattens heterogeneous template payloads into one sheet for office monitoring.


// ---- Reports list → CSV export (Phase 6) ----------------------------------
export const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Flattens each report row for monitoring spreadsheets: fixed metadata columns
// plus one column per top-level key found across all rows' report JSON.
// Arrays of objects become counts, arrays of scalars are joined with "; ",
// nested objects are stringified — so mixed templates still fit one sheet.
export function reportsToCsv(rows) {
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
