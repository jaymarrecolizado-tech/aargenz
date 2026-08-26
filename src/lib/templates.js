// Template registry + system-prompt generation (Phase 2).
// A template defines the fields collected in chat, the generated JSON shape,
// and how the report is rendered (preview/PDF/RTF). Adding a new DICT project
// means dropping a folder under templates/ — no code change.

import builtinAar from "../../templates/aar-elgu/template.json";
import builtinIndex from "../../templates/index.json";

export const DEFAULT_TEMPLATE_ID = "aar-elgu";

// The bundled default template: always available, even without a server.
export const BUILTIN_TEMPLATES = [builtinAar];

const byId = new Map(BUILTIN_TEMPLATES.map(t => [t.id, t]));

export const getBuiltinTemplate = (id) => byId.get(id);

// Fetches the server-side template registry (/api/templates). Falls back to
// the bundled templates when the server is unavailable (file:// mode).
export const fetchTemplates = async () => {
  try {
    const res = await fetch("api/templates");
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        // Server definitions win (admins edit them live); bundled copies
        // back up entries the server can't read.
        return list.map(t => (!t || !t.id || t.error) ? (byId.get(t?.id) || t) : t);
      }
    }
  } catch { /* no proxy/server — use bundled */ }
  return BUILTIN_TEMPLATES;
};

export const getTemplate = (templates, id) =>
  templates.find(t => t.id === id) || templates[0] || builtinAar;

export const loadSavedTemplateId = () => {
  try { return localStorage.getItem("aar-template") || null; } catch { return null; }
};

export const saveTemplateId = (id) => {
  try { localStorage.setItem("aar-template", id); } catch { /* ignore */ }
};

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

export const findField = (template, type) => template.fields?.find(f => f.type === type);
export const textFields = (template) => (template.fields || []).filter(f => f.type === "text");
export const longformFields = (template) => (template.fields || []).filter(f => f.type === "longform");
export const listFields = (template) => (template.fields || []).filter(f => f.type === "list");
export const personFields = (template) => (template.fields || []).filter(f => f.type === "person");
// Manual fields are filled by the user (dropdowns/editing), never collected
// by the AI — keeps prompts and answers shorter.
export const chatFields = (template) =>
  (template.fields || []).filter(f => !f.manual);
export const beneficiariesField = (template) => findField(template, "beneficiaries");

export const beneficiaryCategories = (template) =>
  beneficiariesField(template)?.categories?.map(c => c.id) || [];

const jsonExampleForField = (field) => {
  switch (field.type) {
    case "list":
      return [(field.itemFields || []).reduce((acc, f) => ({ ...acc, [f.id]: "" }), {})];
    case "beneficiaries":
      return (field.categories || []).reduce((acc, c) => ({
        ...acc, [c.id]: { male: 0, female: 0 }
      }), {});
    case "person":
      return { name: "", position: "" };
    case "matrix":
      // Manual in practice, but a valid example keeps ad-hoc templates safe.
      return (field.rows || []).reduce((acc, r) => ({
        ...acc, [r.id]: (field.scales || []).reduce((a, s) => ({ ...a, [s.id]: "" }), {})
      }), {});
    case "captions":
      return [];
    default:
      return ""; // text, longform, choice
  }
};

// Builds the JSON schema example block shown to the model from the field list.
// Manual fields are omitted so the model never emits them.
export const buildJsonSchemaExample = (template) =>
  JSON.stringify(
    chatFields(template).reduce((acc, f) => ({ ...acc, [f.id]: jsonExampleForField(f) }), {}),
    null,
    2
  ).split("\n").map((l, i) => (i ? "    " : "") + l).join("\n");

// Compact human-readable rendering of a stored field value for the
// "ALREADY PROVIDED" system-prompt section. Returns null when empty.
export const describeFieldValue = (field, value) => {
  if (value === null || value === undefined) return null;
  const cap = (s) => {
    s = String(s).trim();
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  };
  switch (field?.type) {
    case "person": {
      const name = String(value.name || "").trim();
      if (!name) return null;
      const pos = String(value.position || "").trim();
      return cap(pos ? `${name} (${pos})` : name);
    }
    case "list": {
      if (!Array.isArray(value)) return null;
      const rows = value.map(it =>
        (field.itemFields || []).map(sf => String(it?.[sf.id] ?? "").trim()).filter(Boolean).join(", ")
      ).filter(Boolean);
      return rows.length ? cap(rows.join("; ")) : null;
    }
    case "beneficiaries": {
      if (!value || typeof value !== "object") return null;
      const parts = Object.entries(value).map(([cid, counts]) => {
        const m = Number(counts?.male ?? 0), f = Number(counts?.female ?? 0);
        return (m || f) ? `${cid}: ${m} male / ${f} female` : null;
      }).filter(Boolean);
      return parts.length ? cap(parts.join("; ")) : null;
    }
    case "matrix": {
      if (!value || typeof value !== "object") return null;
      const parts = Object.entries(value).flatMap(([row, scales]) =>
        Object.entries(scales || {})
          .filter(([, v]) => String(v ?? "").trim() !== "")
          .map(([scale, v]) => `${row}.${scale}=${v}`));
      return parts.length ? cap(parts.join("; ")) : null;
    }
    case "captions": {
      if (!Array.isArray(value)) return null;
      const caps = value.map(c => String(c || "").trim()).filter(Boolean);
      return caps.length ? cap(caps.join(" | ")) : null;
    }
    default: {
      const s = String(typeof value === "string" ? value.trim() : value ?? "");
      return s ? cap(s) : null;
    }
  }
};

// Generates the chat system prompt for a template from its field list.
// `reportData` (optional) is the current report state: anything already filled
// there — by the chat or by the user editing the preview directly — is listed
// in an "ALREADY PROVIDED" section so the assistant never asks for it again.
export const buildSystemPrompt = (template, reportData = null) => {
  const fields = chatFields(template);
  const lines = [];
  lines.push(`You are "Vantage" — one of All Father JE Lite's Creations. Always present yourself as Vantage by name, both when you greet the user and whenever you ask a question or give an answer.`);
  lines.push(`You are an assistant helping fill out an ${template.name} for DICT (Department of Information and Communications Technology) Philippines.`);
  lines.push("");
  lines.push("Your job is to collect information through a friendly conversation, ONE question at a time. Ask the next question only after getting an answer.");
  lines.push("");
  lines.push("Collect these fields in order:");

  let n = 0;
  const push = (label, extra) => { n += 1; lines.push(`${n}. ${label}${extra ? ` (${extra})` : ""}`); };

  for (const f of fields) {
    switch (f.type) {
      case "list":
        push(f.label, f.collectNote);
        break;
      case "longform":
        push(f.label, `for ${f.target} - you will write the formal ${f.target.toLowerCase()} based on their answer`);
        break;
      case "choice":
        push(f.label, `answer with exactly one of: ${(f.options || ["Yes", "No"]).join(" / ")}`);
        break;
      default:
        push(f.label, f.example ? `e.g. ${f.example}` : undefined);
    }
  }

  // Fields already holding a value (chat answers or direct preview edits):
  // listed so the assistant skips them instead of asking again.
  const filled = [];
  if (reportData && typeof reportData === "object") {
    for (const f of template.fields || []) {
      const text = describeFieldValue(f, reportData[f.id]);
      if (text) filled.push(`- ${f.label}: ${text}`);
    }
  }
  if (filled.length) {
    lines.push("");
    lines.push("ALREADY PROVIDED — do NOT ask about these again:");
    lines.push("The user has already given the following, either earlier in this chat or by editing the report preview directly. Treat every entry below as fully collected and NEVER ask for it again:");
    lines.push(...filled);
    lines.push("For entries above that belong to your numbered collection list, copy their exact current value into your progress JSON block (they count as collected toward completion). Entries that belong to preview-only fields not in your collection list must NOT appear in your JSON.");
  }

  lines.push("");
  lines.push("PROGRESS UPDATES (very important):");
  lines.push("After EVERY reply you send, append the data collected SO FAR as a fenced code block in this exact format:");
  lines.push("```json");
  lines.push(buildJsonSchemaExample(template));
  lines.push("```");
  lines.push("- Include ONLY fields the user has already confirmed; omit fields not yet collected (never invent values).");
  lines.push("- The block must always contain the CUMULATIVE data — all confirmed fields, not just the latest one.");
  lines.push("- When ALL fields above are collected, the block becomes the COMPLETE report JSON and your reply ends with it (nothing after the block).");
  lines.push("");
  lines.push("Important:");
  for (const f of fields) {
    if (f.type === "longform" && f.styleNote) {
      lines.push(`- ${f.target}: ${f.styleNote}`);
    }
  }
  lines.push("- Keep conversation friendly and clear");
  if (fields.some(f => f.type === "list" && f.doneAccepted)) {
    lines.push(`- If user says "done" or "that's all" when adding ${fields.filter(f => f.type === "list" && f.doneAccepted).map(f => f.itemLabel?.toLowerCase() + "s").join(" or ")}, accept it`);
  }
  for (const note of template.promptNotes || []) lines.push(`- ${note}`);
  return lines.join("\n");
};
