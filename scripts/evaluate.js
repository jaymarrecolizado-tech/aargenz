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

async function callModel({ endpoint, model, teacher, messages }) {
  const body = {
    model: teacher ? "llama-3.3-70b-versatile" : model,
    max_tokens: 4000,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages
  };
  const headers = { "Content-Type": "application/json" };
  if (teacher) {
    const key = process.env.GROQ_API_KEY || readKeyFromConfig();
    if (!key) throw new Error("GROQ_API_KEY not set (needed for --teacher)");
    headers.Authorization = `Bearer ${key}`;
  }
  const url = teacher
    ? "https://api.groq.com/openai/v1/chat/completions"
    : String(endpoint).replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Model error ${res.status}: ${errData.error?.message || JSON.stringify(errData)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
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

function readKeyFromConfig() {
  try {
    const cfg = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
    const m = cfg.match(/GROQ_API_KEY\s*:\s*["']([^"']+)["']/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
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
