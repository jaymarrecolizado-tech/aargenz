// Shared report helpers: normalization, schema validation and JSON extraction.
// Used by the React app, tests and (later) server-side persistence.
import { validateWithTemplate, validateRawReport } from "./schema.js";

export const DEFAULT_REPORT = {
  title: "", dateTime: "", mode: "", controlNo: "",
  facilitators: [],
  beneficiaries: {
    ngas: { male: 0, female: 0 },
    lgus: { male: 0, female: 0 },
    sucs: { male: 0, female: 0 },
    others: { male: 0, female: 0 }
  },
  rationale: "", highlights: "",
  preparedBy: { name: "", position: "" },
  conformedBy: { name: "", position: "" }
};

export const BEN_KEYS = ["ngas", "lgus", "sucs", "others"];

// Models sometimes capitalize the beneficiary category keys ("NGAs",
// "LGUs", "SUCs", "Others" — e.g. Groq's gpt-oss-120b). Look them up
// case-insensitively so counts are never silently zeroed.
export const pickBenCat = (ben, key) => {
  if (!ben || typeof ben !== "object") return undefined;
  if (ben[key] !== undefined) return ben[key];
  const match = Object.keys(ben).find(k => k.toLowerCase() === key);
  return match !== undefined ? ben[match] : undefined;
};

export const normalizeReport = (raw, template) => {
  const d = { ...DEFAULT_REPORT, ...(raw || {}) };
  // Beneficiary categories come from the active template (defaults to the
  // classic AAR set when no template is given).
  const keys = template
    ? (template.fields || []).filter(f => f.type === "beneficiaries")
        .flatMap(f => (f.categories || []).map(c => c.id))
    : BEN_KEYS;
  const ben = d.beneficiaries || {};
  const nextBen = {};
  for (const k of keys.length ? keys : BEN_KEYS) {
    const cat = pickBenCat(ben, k);
    nextBen[k] = {
      male: Number(cat?.male) || 0,
      female: Number(cat?.female) || 0
    };
  }
  d.beneficiaries = nextBen;
  d.facilitators = Array.isArray(d.facilitators)
    ? d.facilitators.map(f => ({ name: f?.name || "", office: f?.office || "", gender: f?.gender || "" }))
    : [];
  d.preparedBy = { ...DEFAULT_REPORT.preparedBy, ...(d.preparedBy || {}) };
  d.conformedBy = { ...DEFAULT_REPORT.conformedBy, ...(d.conformedBy || {}) };
  return d;
};

// Extracts a JSON object from LLM output that may be fenced with markdown
// code blocks or embedded in surrounding prose. Returns null when no valid
// JSON object can be recovered.
export const extractJson = (text) => {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  const candidates = [cleaned];
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next candidate */ }
  }
  return null;
};

const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Validates a (normalized) report against a Zod schema built from the
// template's field list (Phase 5.1). See src/lib/schema.js.
// Returns an array of human-readable error strings; empty array = valid.
export const validateReportSchema = (report, template) => validateWithTemplate(report, template);

// Strict check on the model's raw JSON output, before normalization repairs
// anything. See src/lib/schema.js.
export const validateRawLlmJson = (raw, template) => validateRawReport(raw, template);

const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;

// Extracts the LAST fenced ```json block from a chat reply — the model is
// instructed (Phase 7.3) to append its cumulative progress block after every
// message. Returns the parsed object or null.
export const extractProgress = (text) => {
  if (!text) return null;
  const blocks = [...String(text).matchAll(fenceRe)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(blocks[i][1].trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch { /* try earlier block */ }
  }
  return null;
};

// True when every AI-collected (non-manual) field has a value, i.e. the
// progress block can be treated as the final report.
export const isCompleteProgress = (obj, template) => {
  if (!obj || typeof obj !== "object") return false;
  const fields = (template?.fields || []).filter(f => !f.manual);
  const ids = fields.length ? fields.map(f => f.id)
    : ["title", "dateTime", "mode", "controlNo", "facilitators", "beneficiaries", "rationale", "highlights"];
  return ids.every(id => {
    const v = obj[id];
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === "object";
  });
};

// Deep-merges new progress into previously collected data. Objects merge
// recursively; arrays and scalars are replaced wholesale.
export const mergeProgress = (base, patch) => {
  if (base === null || base === undefined) return patch ?? null;
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== "object" || typeof patch !== "object") {
    return String(patch).trim() !== "" ? patch : base;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeProgress(base[k], v);
  return out;
};
