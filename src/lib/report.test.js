import { describe, it, expect } from "vitest";
import {
  DEFAULT_REPORT,
  BEN_KEYS,
  normalizeReport,
  extractJson,
  extractProgress,
  isCompleteProgress,
  mergeProgress,
  validateReportSchema,
  validateRawLlmJson,
  pickBenCat
} from "./report.js";

describe("extractJson", () => {
  it("parses a plain JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON fenced with ```json blocks", () => {
    const text = 'Here is your report:\n```json\n{"title":"Test"}\n```';
    expect(extractJson(text)).toEqual({ title: "Test" });
  });

  it("parses JSON embedded in prose", () => {
    const text = 'Sure! {"title":"X","count":2} hope that helps.';
    expect(extractJson(text)).toEqual({ title: "X", count: 2 });
  });

  it("handles multiline objects", () => {
    const text = '{\n  "title": "A",\n  "facilitators": [{"name": "N"}]\n}';
    expect(extractJson(text)).toEqual({ title: "A", facilitators: [{ name: "N" }] });
  });

  it("returns null for non-JSON text", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });

  it("returns null for empty/missing input", () => {
    expect(extractJson(null)).toBeNull();
    expect(extractJson(undefined)).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("normalizeReport", () => {
  it("returns defaults for null input", () => {
    const r = normalizeReport(null);
    expect(r.title).toBe("");
    expect(r.beneficiaries).toEqual(DEFAULT_REPORT.beneficiaries);
    expect(r.facilitators).toEqual([]);
    expect(r.preparedBy).toEqual({ name: "", position: "" });
    expect(r.conformedBy).toEqual({ name: "", position: "" });
  });

  it("fills missing beneficiary categories and coerces numbers", () => {
    const r = normalizeReport({
      beneficiaries: { ngas: { male: "5", female: "x" } }
    });
    expect(r.beneficiaries.ngas).toEqual({ male: 5, female: 0 });
    for (const k of ["lgus", "sucs", "others"]) {
      expect(r.beneficiaries[k]).toEqual({ male: 0, female: 0 });
    }
  });

  it("looks up capitalized category keys case-insensitively", () => {
    const r = normalizeReport({
      beneficiaries: {
        NGAs: { male: 3, female: 4 },
        LGUs: { male: 1, female: 2 },
        SUCs: { male: 0, female: 7 },
        Others: { male: 9, female: 8 }
      }
    });
    expect(r.beneficiaries.ngas).toEqual({ male: 3, female: 4 });
    expect(r.beneficiaries.lgus).toEqual({ male: 1, female: 2 });
    expect(r.beneficiaries.sucs).toEqual({ male: 0, female: 7 });
    expect(r.beneficiaries.others).toEqual({ male: 9, female: 8 });
  });

  it("normalizes facilitators and drops garbage entries", () => {
    const r = normalizeReport({
      facilitators: [
        { name: " Ana ", office: "DICT RO2", gender: "F" },
        null,
        { name: "Ben" }
      ]
    });
    expect(r.facilitators).toEqual([
      { name: " Ana ", office: "DICT RO2", gender: "F" },
      { name: "", office: "", gender: "" },
      { name: "Ben", office: "", gender: "" }
    ]);
  });

  it("treats a non-array facilitators field as empty", () => {
    expect(normalizeReport({ facilitators: "two" }).facilitators).toEqual([]);
  });

  it("merges partial preparedBy/conformedBy", () => {
    const r = normalizeReport({ preparedBy: { name: "Cruz" } });
    expect(r.preparedBy).toEqual({ name: "Cruz", position: "" });
    expect(r.conformedBy).toEqual({ name: "", position: "" });
  });

  it("keeps unknown top-level fields", () => {
    const r = normalizeReport({ customField: "kept" });
    expect(r.customField).toBe("kept");
  });
});

describe("pickBenCat", () => {
  it("returns undefined for non-objects", () => {
    expect(pickBenCat(null, "ngas")).toBeUndefined();
    expect(pickBenCat(undefined, "ngas")).toBeUndefined();
    expect(pickBenCat("x", "ngas")).toBeUndefined();
  });

  it("matches keys case-insensitively", () => {
    expect(pickBenCat({ Others: 5 }, "others")).toBe(5);
    expect(pickBenCat({ OTHERS: 5 }, "others")).toBe(5);
  });
});

describe("validateReportSchema", () => {
  const validReport = normalizeReport({
    title: "Training",
    dateTime: "Dec 1-2, 2025 | 9am-5pm",
    mode: "Face-to-Face",
    controlNo: "eLGU-R2-12-04-2025-S157",
    facilitators: [{ name: "Ana", office: "DICT", gender: "F" }],
    beneficiaries: { ngas: { male: 1, female: 2 } },
    rationale: "Because",
    highlights: "Things",
    preparedBy: { name: "Cruz", position: "Encoder" },
    conformedBy: { name: "Reyes", position: "Chief" }
  });

  it("accepts a fully populated report", () => {
    expect(validateReportSchema(validReport)).toEqual([]);
  });

  it("accepts an empty normalized report (all defaults present)", () => {
    expect(validateReportSchema(normalizeReport({}))).toEqual([]);
  });

  it("rejects missing string fields", () => {
    const bad = { ...validReport, title: undefined };
    expect(validateReportSchema(bad)).toContain("title must be a string");
  });

  it("rejects non-numeric beneficiary counts", () => {
    const bad = {
      ...validReport,
      beneficiaries: { ...validReport.beneficiaries, lgus: { male: "3", female: 1 } }
    };
    const errors = validateReportSchema(bad);
    expect(errors.some(e => e.includes("beneficiaries.lgus"))).toBe(true);
  });

  it("rejects malformed facilitator rows and signatories", () => {
    const errors = validateReportSchema({
      ...validReport,
      facilitators: [{ name: "Ana" }],
      preparedBy: { name: 5 }
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.startsWith("facilitators[0]"))).toBe(true);
    expect(errors.some(e => e === "preparedBy must have name/position strings")).toBe(true);
  });

  it("handles null input without throwing", () => {
    expect(Array.isArray(validateReportSchema(null))).toBe(true);
  });
});

describe("validateRawLlmJson (raw model output, pre-normalization)", () => {
  const goodRaw = {
    title: "Training on X",
    beneficiaries: { NGAs: { male: "5", female: 3 } },
    facilitators: [{ name: "Ana" }],
    preparedBy: { name: "Cruz", position: "Encoder" }
  };

  it("accepts raw output with LLM quirks (capitalized keys, numeric strings, missing fields)", () => {
    expect(validateRawLlmJson(goodRaw)).toEqual([]);
  });

  it("rejects non-object responses", () => {
    expect(validateRawLlmJson([1, 2]).length).toBeGreaterThan(0);
    expect(validateRawLlmJson("nope").length).toBeGreaterThan(0);
    expect(validateRawLlmJson(null).length).toBeGreaterThan(0);
  });

  it("rejects a report missing the anchor text field (title)", () => {
    const errors = validateRawLlmJson({ rationale: "only this" });
    expect(errors).toContain("title must be a non-empty string");
  });

  it("rejects an empty-string title", () => {
    const errors = validateRawLlmJson({ ...goodRaw, title: "   " });
    expect(errors.some(e => e.startsWith("title"))).toBe(true);
  });

  it("rejects non-numeric beneficiary counts but tolerates absent categories", () => {
    const errors = validateRawLlmJson({
      ...goodRaw,
      beneficiaries: { ngas: { male: "many", female: 1 } }
    });
    expect(errors).toContain("beneficiaries.ngas must contain numeric male/female counts");
    expect(validateRawLlmJson({ ...goodRaw, beneficiaries: { lgus: { male: 1, female: 2 } } })).toEqual([]);
  });

  it("rejects a non-array or non-object-list facilitators field", () => {
    let errors = validateRawLlmJson({ ...goodRaw, facilitators: "Ana and Ben" });
    expect(errors).toContain("facilitators must be a list");
    errors = validateRawLlmJson({ ...goodRaw, facilitators: ["Ana"] });
    expect(errors.some(e => e.includes("must be an object"))).toBe(true);
  });

  it("rejects malformed person fields", () => {
    const errors = validateRawLlmJson({ ...goodRaw, conformedBy: "Chief Reyes" });
    expect(errors.some(e => e.startsWith("conformedBy"))).toBe(true);
  });
});

describe("progressive JSON (Phase 7.3)", () => {
  const tpl = {
    fields: [
      { id: "title", type: "text" },
      { id: "dateTime", type: "text" },
      { id: "facilitators", type: "list" },
      { id: "rationale", type: "longform" },
      { id: "beneficiaries", type: "beneficiaries" },
      { id: "preparedBy", type: "person", manual: true }
    ]
  };

  it("extractProgress returns the last fenced JSON block", () => {
    const text = 'Great! Next question...\n```json\n{"title":"A"}\n```\nAnd also:\n```json\n{"title":"B","dateTime":"X"}\n```';
    expect(extractProgress(text)).toEqual({ title: "B", dateTime: "X" });
  });

  it("extractProgress returns null without a valid block", () => {
    expect(extractProgress("no blocks here")).toBeNull();
    expect(extractProgress(null)).toBeNull();
  });

  it("isCompleteProgress is false while fields are missing and ignores manual ones", () => {
    const partial = { title: "T", dateTime: "D" };
    expect(isCompleteProgress(partial, tpl)).toBe(false);
    const full = { title: "T", dateTime: "D", facilitators: [{ name: "A" }], rationale: "R", beneficiaries: { ngas: { male: 1, female: 0 } } };
    // preparedBy is manual so its absence still counts as complete
    expect(isCompleteProgress(full, tpl)).toBe(true);
  });

  it("mergeProgress deep-merges objects but replaces arrays", () => {
    const base = { title: "Old", beneficiaries: { ngas: { male: 1, female: 2 }, lgus: {} } };
    const patch = { title: "", beneficiaries: { ngas: { male: 5 } }, facilitators: [{ name: "Z" }] };
    const merged = mergeProgress(base, patch);
    expect(merged.title).toBe("Old"); // empty patch does not erase
    expect(merged.beneficiaries.ngas.male).toBe(5);
    expect(merged.beneficiaries.ngas.female).toBe(2);
    expect(merged.facilitators).toEqual([{ name: "Z" }]);
  });

  it("mergeProgress handles null base", () => {
    expect(mergeProgress(null, { title: "A" })).toEqual({ title: "A" });
  });
});

