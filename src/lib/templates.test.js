import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildJsonSchemaExample,
  getTemplate,
  beneficiaryCategories
} from "./templates.js";
import { normalizeReport, validateReportSchema } from "./report.js";
import builtinAar from "../../templates/aar-elgu/template.json";

describe("template config (aar-elgu)", () => {
  it("has the expected shape", () => {
    expect(builtinAar.id).toBe("aar-elgu");
    expect(Array.isArray(builtinAar.fields)).toBe(true);
    expect(builtinAar.initialMessage.role).toBe("assistant");
  });
});

describe("buildSystemPrompt", () => {
  it("generates a prompt containing every AI-collected field label in order", () => {
    const prompt = buildSystemPrompt(builtinAar);
    // Manual fields are never collected by the AI (Phase 7.1).
    const labels = builtinAar.fields.filter(f => !f.manual).map(f => f.label);
    let pos = -1;
    for (const label of labels) {
      const next = prompt.indexOf(label, pos + 1);
      expect(next).toBeGreaterThan(pos);
      pos = next;
    }
    for (const f of builtinAar.fields.filter(f => f.manual)) {
      expect(prompt).not.toContain(f.label);
    }
  });

  it("includes the JSON schema example with all AI-collected field ids", () => {
    const prompt = buildSystemPrompt(builtinAar);
    for (const f of builtinAar.fields) {
      if (f.manual) expect(prompt).not.toContain(`"${f.id}"`);
      else expect(prompt).toContain(`"${f.id}"`);
    }
    expect(prompt).toContain('"facilitators": [');
    expect(prompt).toContain('"male": 0');
  });

  it("mentions longform style notes and list done-acceptance rules", () => {
    const prompt = buildSystemPrompt(builtinAar);
    expect(prompt).toContain("Rationale: Write in formal");
    expect(prompt).toMatch(/"done" or "that's all"/);
  });

  it("works for a template without beneficiaries or lists", () => {
    const minimal = {
      id: "t-min",
      name: "Simple Memo",
      fields: [
        { id: "title", label: "Memo title", type: "text" },
        { id: "body", label: "What happened?", target: "Body", type: "longform", styleNote: "Keep it brief" }
      ]
    };
    const prompt = buildSystemPrompt(minimal);
    expect(prompt).toContain("Simple Memo");
    expect(prompt).toContain('"body": ""');
    expect(prompt).not.toContain('"done" or "that\'s all"');
  });
});

describe("buildSystemPrompt ALREADY PROVIDED section", () => {
  const tpl = {
    id: "t-manual",
    name: "Manual Aware Report",
    fields: [
      { id: "title", label: "Activity title", type: "text" },
      { id: "venue", label: "Venue", type: "text", manual: true },
      { id: "preparedBy", label: "Prepared by", type: "person", manual: true },
      { id: "facilitators", label: "Facilitators", type: "list", itemFields: [{ id: "name", type: "text" }, { id: "office", type: "text" }] },
      { id: "ben", label: "Beneficiary breakdown", type: "beneficiaries", categories: [{ id: "ngas", label: "NGAs" }] }
    ]
  };

  it("lists hand-edited values and forbids re-asking", () => {
    const prompt = buildSystemPrompt(tpl, {
      title: "",
      venue: "DICT Regional Office",
      preparedBy: { name: "Rica V. Casuga", position: "Chief" },
      facilitators: [{ name: "Ana Reyes", office: "DICT" }],
      ben: { ngas: { male: 3, female: 4 } }
    });
    expect(prompt).toContain("ALREADY PROVIDED");
    expect(prompt).toContain("- Venue: DICT Regional Office");
    expect(prompt).toContain("- Prepared by: Rica V. Casuga (Chief)");
    expect(prompt).toContain("- Facilitators: Ana Reyes, DICT");
    expect(prompt).toContain("- Beneficiary breakdown: ngas: 3 male / 4 female");
    expect(prompt).toMatch(/NEVER ask/i);
  });

  it("skips empty values but keeps partially filled ones", () => {
    const prompt = buildSystemPrompt(tpl, {
      title: "",
      venue: "",
      preparedBy: { name: "", position: "" },
      ben: { ngas: { male: 0, female: 2 } }
    });
    expect(prompt).toContain("ALREADY PROVIDED");
    expect(prompt).toContain("ngas: 0 male / 2 female");
    expect(prompt).not.toContain("- Activity title:");
    expect(prompt).not.toContain("- Venue:");
    expect(prompt).not.toContain("- Prepared by:");
  });

  it("omits the section entirely when nothing is filled", () => {
    expect(buildSystemPrompt(tpl, {})).not.toContain("ALREADY PROVIDED");
    expect(buildSystemPrompt(tpl)).not.toContain("ALREADY PROVIDED");
    expect(buildSystemPrompt(tpl, null)).not.toContain("ALREADY PROVIDED");
  });

  it("caps very long values", () => {
    const long = "x".repeat(500);
    const prompt = buildSystemPrompt({ ...tpl, fields: [tpl.fields[0]] }, { title: long });
    expect(prompt).toContain("x".repeat(300) + "…");
  });
});

describe("buildJsonSchemaExample", () => {
  it("omits manual person fields but keeps AI-collected ones", () => {
    const json = JSON.parse(buildJsonSchemaExample(builtinAar));
    expect(json.preparedBy).toBeUndefined();
    expect(json.conformedBy).toBeUndefined();
    expect(json.title).toBe("");
  });

  it("emits non-manual person fields as name/position objects", () => {
    const t = { id: "t-p", name: "P", fields: [{ id: "signedBy", label: "Signatory", type: "person" }] };
    const json = JSON.parse(buildJsonSchemaExample(t));
    expect(json.signedBy).toEqual({ name: "", position: "" });
  });

  it("emits beneficiaries as zeroed category objects", () => {
    const json = JSON.parse(buildJsonSchemaExample(builtinAar));
    expect(json.beneficiaries.ngas).toEqual({ male: 0, female: 0 });
    expect(json.beneficiaries.others).toEqual({ male: 0, female: 0 });
  });
});

describe("getTemplate / beneficiaryCategories", () => {
  it("falls back to the first template when the id is unknown", () => {
    const t = getTemplate([builtinAar], "nope");
    expect(t.id).toBe("aar-elgu");
  });

  it("lists category ids from the template", () => {
    expect(beneficiaryCategories(builtinAar)).toEqual(["ngas", "lgus", "sucs", "others"]);
  });
});

describe("template-driven normalization", () => {
  const custom = {
    id: "t-custom",
    name: "Custom",
    fields: [
      { id: "title", label: "Title", type: "text" },
      {
        id: "beneficiaries",
        type: "beneficiaries",
        categories: [{ id: "farmers" }, { id: "fisherfolk" }]
      }
    ]
  };

  it("normalizes custom beneficiary categories", () => {
    const r = normalizeReport({ beneficiaries: { Farmers: { male: "2", female: 3 } } }, custom);
    expect(r.beneficiaries.farmers).toEqual({ male: 2, female: 3 });
    expect(r.beneficiaries.fisherfolk).toEqual({ male: 0, female: 0 });
    // classic keys are not part of this template
    expect(r.beneficiaries.ngas).toBeUndefined();
  });

  it("validates against custom template categories", () => {
    const r = normalizeReport({}, custom);
    expect(validateReportSchema(r, custom)).toEqual([]);
    // Raw (un-normalized) data with missing/non-numeric counts must fail.
    const bad = { beneficiaries: { farmers: { male: "x" } } };
    expect(validateReportSchema(bad, custom).some(e => e.includes("beneficiaries.farmers"))).toBe(true);
  });
});
