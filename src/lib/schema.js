// Zod-based report schema (Phase 5.1), built from a template's field list so
// every template gets validation for free. Validates the final LLM JSON
// (after normalizeReport) before it is shown, exported or persisted.
import { z } from "zod";

const str = () => z.string();
const count = () => z.number(); // strict: normalizeReport coerces beforehand

// Classic AAR shape used when no template config is available.
const CLASSIC = {
  textFields: ["title", "dateTime", "mode", "controlNo", "rationale", "highlights"],
  facilitatorItemFields: ["name", "office", "gender"],
  beneficiaryCategories: ["ngas", "lgus", "sucs", "others"],
  personFields: ["preparedBy", "conformedBy"]
};

export const buildReportSchema = (template) => {
  const shape = {};
  const fields = template?.fields;

  if (!Array.isArray(fields) || !fields.length) {
    for (const id of CLASSIC.textFields) shape[id] = str();
    shape.facilitators = z.array(
      z.object(Object.fromEntries(CLASSIC.facilitatorItemFields.map(f => [f, str()])))
    );
    shape.beneficiaries = z.object(
      Object.fromEntries(CLASSIC.beneficiaryCategories.map(c => [c, z.object({ male: count(), female: count() })]))
    );
    for (const p of CLASSIC.personFields) shape[p] = z.object({ name: str(), position: str() });
    return z.object(shape);
  }

  for (const f of fields) {
    switch (f.type) {
      case "text":
      case "longform":
      case "choice":
        shape[f.id] = str();
        break;
      case "list":
        shape[f.id] = z.array(
          z.object(Object.fromEntries((f.itemFields || []).map(i => [i.id, str()])))
        );
        break;
      case "beneficiaries":
        shape[f.id] = z.object(
          Object.fromEntries((f.categories || []).map(c => [c.id, z.object({ male: count(), female: count() })]))
        );
        break;
      case "person":
        shape[f.id] = z.object({ name: str(), position: str() });
        break;
      case "matrix":
        // rows × scales of condition strings ("good"/"fair"/"poor"/"")
        shape[f.id] = z.object(
          Object.fromEntries((f.rows || []).map(r => [
            r.id,
            z.object(Object.fromEntries((f.scales || []).map(s => [s.id, str()])))
          ]))
        );
        break;
      case "captions":
        shape[f.id] = z.array(str());
        break;
      default:
        break; // unknown field types are not validated
    }
  }
  return z.object(shape);
};

const fmtPath = (segments) =>
  segments.reduce((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : String(s)), "");

// Maps Zod issues to the human-readable messages the app and tests expect.
export const formatValidationIssues = (issues) => {
  const out = [];
  for (const iss of issues) {
    const segs = iss.path || [];
    if (segs[0] === "beneficiaries") {
      out.push(`${fmtPath(segs.slice(0, 2))} must contain numeric male/female counts`);
    } else if (segs[0] === "facilitators") {
      out.push(`facilitators[${segs[1]}] must have name/office/gender strings`);
    } else if (segs[0] === "preparedBy" || segs[0] === "conformedBy") {
      out.push(`${segs[0]} must have name/position strings`);
    } else if (!segs.length) {
      out.push("Report must be an object");
    } else {
      out.push(`${fmtPath(segs)} must be a string`);
    }
  }
  return [...new Set(out)];
};

// Returns an array of human-readable error strings; empty array = valid.
export const validateWithTemplate = (report, template) => {
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["Report must be an object"];
  const result = buildReportSchema(template).safeParse(report);
  return result.success ? [] : formatValidationIssues(result.error.issues);
};

const numLike = (v) => typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));

// Validates the RAW JSON emitted by the model, BEFORE normalizeReport gets a
// chance to repair it. Tolerant of known LLM quirks (capitalized beneficiary
// keys, counts as numeric strings, missing optional fields) but rejects
// responses that aren't actually a report — e.g. when extractJson grabs the
// wrong JSON from prose. Returns error strings; empty array = OK.
export const validateRawReport = (raw, template) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["The response did not contain a valid report object"];
  }
  const fields = template?.fields;
  const errors = [];

  // Anchor check: the template's first plain-text field (always "Activity
  // title" in practice) must be a real non-empty string.
  const anchorId = ((fields || []).find(f => f.type === "text") || {}).id || "title";
  const anchorVal = raw[anchorId];
  if (typeof anchorVal !== "string" || !anchorVal.trim()) {
    errors.push(`${anchorId} must be a non-empty string`);
  }

  const benField = (fields || []).find(f => f.type === "beneficiaries");
  const catIds = benField ? (benField.categories || []).map(c => c.id) : CLASSIC.beneficiaryCategories;
  const rawBenKey = benField?.id || "beneficiaries";
  const rawBen = raw[rawBenKey];
  if (rawBen !== undefined && rawBen !== null) {
    if (typeof rawBen !== "object" || Array.isArray(rawBen)) {
      errors.push(`${rawBenKey} must be an object`);
    } else {
      for (const cat of catIds) {
        const key = Object.keys(rawBen).find(k => k.toLowerCase() === cat.toLowerCase());
        const val = key !== undefined ? rawBen[key] : undefined;
        if (val === undefined || val === null) continue; // normalizeReport fills zeros
        if (!val || typeof val !== "object" || Array.isArray(val) || !numLike(val.male) || !numLike(val.female)) {
          errors.push(`beneficiaries.${cat} must contain numeric male/female counts`);
        }
      }
    }
  }

  const listField = (fields || []).find(f => f.type === "list");
  const listKey = listField?.id || "facilitators";
  const rawList = raw[listKey];
  if (rawList !== undefined && rawList !== null) {
    if (!Array.isArray(rawList)) {
      errors.push(`${listKey} must be a list`);
    } else if (rawList.some(f => !f || typeof f !== "object" || Array.isArray(f))) {
      errors.push(`each ${listKey.replace(/s$/, "")} entry must be an object`);
    }
  }

  const personFields = (fields || []).filter(f => f.type === "person");
  for (const p of personFields.length ? personFields.map(f => f.id) : CLASSIC.personFields) {
    const v = raw[p];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v) ||
        (("name" in v) && typeof v.name !== "string") || (("position" in v) && typeof v.position !== "string")) {
      errors.push(`${p} must contain name and position`);
    }
  }

  return [...new Set(errors)];
};
