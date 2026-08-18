#!/usr/bin/env node
// Eval harness for the AAR model.
//
// Replays held-out conversations from a dataset against a model endpoint and
// scores JSON-validity + schema completeness, reusing the app's own
// extractJson / normalizeReport logic (read from index.html so they stay in
// sync with the app).
//
// Usage:
//   # score the local model
//   node scripts/evaluate.js --dataset dataset.jsonl \
//     --endpoint http://localhost:11434/v1 --model qwen3:14b --limit 50
//
//   # score the live teacher (Groq) for comparison
//   GROQ_API_KEY=... node scripts/evaluate.js --dataset dataset.jsonl --teacher --limit 50
//
// Writes a summary to stdout and a full report to --out (default eval-report.json).

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Pull extractJson / normalizeReport / DEFAULT_REPORT from index.html so the
// eval uses the exact same validation logic as the app.
// ---------------------------------------------------------------------------

function loadAppLogic() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf("const DEFAULT_REPORT");
  const end = html.indexOf("function ReportPreview");
  if (start < 0 || end < 0) throw new Error("Could not locate app logic in index.html");
  const slice = html.slice(start, end);
  const fn = new Function(
    "CONFIG",
    "localStorage",
    slice + "; return { extractJson, normalizeReport, DEFAULT_REPORT };"
  );
  // Stub browser globals the app logic touches at load time.
  return fn({}, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
}

const { extractJson, normalizeReport, DEFAULT_REPORT } = loadAppLogic();

// ---------------------------------------------------------------------------
// Schema completeness check
// ---------------------------------------------------------------------------

function schemaOk(report) {
  const b = report.beneficiaries || {};
  const okBen = (v) => typeof v === "number" && v >= 0;
  const cats = ["ngas", "lgus", "sucs", "others"].every(k =>
    b[k] && okBen(b[k].male) && okBen(b[k].female)
  );
  const okFac = Array.isArray(report.facilitators) &&
    report.facilitators.every(f =>
      f && typeof f.name === "string" && typeof f.office === "string" &&
      /^[MF]$/i.test(String(f.gender || ""))
    );
  return Boolean(
    report.title && report.dateTime && report.mode && report.controlNo &&
    cats && okFac &&
    report.rationale && report.highlights &&
    report.preparedBy?.name && report.preparedBy?.position &&
    report.conformedBy?.name && report.conformedBy?.position
  );
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

// Shared pool of Groq API keys for the teacher path (env GROQ_API_KEYS="k1,k2"
// or a single GROQ_API_KEY; falls back to config.js). callModel() rotates to
// the next key automatically when the active one is rate-limited (429) or
// rejected (401/403).
const GROQ_KEYS = readGroqKeys();
let groqKeyCursor = 0; // index of the last key that worked

function readGroqKeys() {
  const fromEnv = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
    .split(",").map(k => k.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const cfg = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
    const arr = cfg.match(/GROQ_API_KEYS\s*:\s*\[([^\]]*)\]/);
    if (arr) {
      const keys = (arr[1].match(/["'][^"']+["']/g) || [])
        .map(k => k.replace(/["']/g, "").trim()).filter(Boolean);
      if (keys.length) return keys;
    }
    const single = cfg.match(/GROQ_API_KEY\s*:\s*["']([^"']+)["']/);
    return single ? [single[1]] : [];
  } catch {
    return [];
  }
}

async function callModel({ endpoint, model, teacher, messages }) {
  const body = {
    model: teacher ? "openai/gpt-oss-120b" : model,
    max_tokens: 4000,
    temperature: 0.2,
    // No response_format: the model collects data one question at a time and
    // only emits the final JSON at the end. gpt-oss-120b (the teacher) rejects
    // json_object mode because it answers in prose, and the app itself no
    // longer sends it (see openAiBody in index.html). extractJson() below is
    // the safety net, matching app behavior.
    messages
  };
  const headers = { "Content-Type": "application/json" };
  const url = teacher
    ? "https://api.groq.com/openai/v1/chat/completions"
    : String(endpoint).replace(/\/+$/, "") + "/chat/completions";

  if (!teacher) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Model error ${res.status}: ${errData.error?.message || JSON.stringify(errData)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  // Teacher path: try each Groq key in turn, rotating on rate limit / invalid key.
  if (!GROQ_KEYS.length) throw new Error("GROQ_API_KEY / GROQ_API_KEYS not set (needed for --teacher)");
  const start = groqKeyCursor % GROQ_KEYS.length;
  let lastErr = null;
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const idx = (start + i) % GROQ_KEYS.length;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${GROQ_KEYS[idx]}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = `Model error ${res.status}: ${errData.error?.message || JSON.stringify(errData)}`;
        lastErr = new Error(msg);
        if ([401, 403, 429].includes(res.status) && i < GROQ_KEYS.length - 1) {
          console.warn(`  Groq key ${idx + 1}/${GROQ_KEYS.length} returned ${res.status}; trying next key`);
          continue;
        }
        throw lastErr;
      }
      groqKeyCursor = idx; // remember the key that worked
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (e) {
      lastErr = e;
      if (i < GROQ_KEYS.length - 1 && /ECONN|fetch failed|network|timeout/i.test(e.message || "")) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("All Groq API keys failed");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dataset: "dataset.jsonl", limit: 0, endpoint: "http://localhost:11434/v1", model: "qwen3:14b", teacher: false, out: "eval-report.json" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dataset") args.dataset = argv[++i];
    else if (argv[i] === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === "--endpoint") args.endpoint = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--teacher") args.teacher = true;
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = fs.readFileSync(args.dataset, "utf8").split("\n").filter(Boolean);
  const examples = lines.map(l => JSON.parse(l));
  const total = args.limit > 0 ? Math.min(args.limit, examples.length) : examples.length;
  const target = args.teacher ? "teacher (Groq)" : `${args.model} @ ${args.endpoint}`;
  console.log(`Evaluating ${total}/${examples.length} conversations against: ${target}`);

  const results = [];
  let valid = 0;
  let complete = 0;

  for (let i = 0; i < total; i++) {
    const ex = examples[i];
    const msgs = ex.messages || [];
    // The last assistant message holds the final JSON – replay everything before it.
    let cut = msgs.length;
    for (let j = msgs.length - 1; j >= 0; j--) {
      if (msgs[j].role === "assistant" && /"title"/.test(msgs[j].content || "")) { cut = j; break; }
    }
    const prompt = msgs.slice(0, cut);
    if (prompt.length < 2) { console.error(`  example ${i}: no usable prompt, skipping`); continue; }

    let text;
    try {
      text = await callModel({ ...args, messages: prompt });
    } catch (e) {
      console.error(`  example ${i}: call failed – ${e.message}`);
      results.push({ index: i, error: e.message });
      continue;
    }

    const parsed = extractJson(text);
    const r = { index: i, parsed: !!parsed, complete: false };
    if (parsed) {
      valid++;
      const normalized = normalizeReport(parsed);
      r.complete = schemaOk(normalized);
      if (r.complete) complete++;
      r.missing = missingFields(normalized);
    }
    results.push(r);

    if ((i + 1) % 10 === 0) {
      console.log(`  ${i + 1}/${total} (valid JSON: ${valid}, complete: ${complete})`);
    }
  }

  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
  console.log("--------------------------------------------------");
  console.log(`Valid JSON:     ${valid}/${total} (${pct(valid)}%)`);
  console.log(`Schema complete: ${complete}/${total} (${pct(complete)}%)`);
  console.log(`Errors:         ${results.filter(r => r.error).length}`);

  const failures = results.filter(r => !r.complete && !r.error).slice(0, 3);
  if (failures.length) {
    console.log("Sample failures:");
    failures.forEach(f => console.log(`  #${f.index} parsed=${f.parsed} missing=${JSON.stringify(f.missing)}`));
  }

  fs.writeFileSync(args.out, JSON.stringify({ target, total, valid, complete, results }, null, 2));
  console.log(`Full report -> ${args.out}`);
}

function missingFields(report) {
  const missing = [];
  if (!report.title) missing.push("title");
  if (!report.dateTime) missing.push("dateTime");
  if (!report.mode) missing.push("mode");
  if (!report.controlNo) missing.push("controlNo");
  if (!report.rationale) missing.push("rationale");
  if (!report.highlights) missing.push("highlights");
  if (!report.preparedBy?.name) missing.push("preparedBy.name");
  if (!report.conformedBy?.name) missing.push("conformedBy.name");
  return missing;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
