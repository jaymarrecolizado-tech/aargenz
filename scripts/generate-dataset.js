#!/usr/bin/env node
// Synthetic AAR training-data generator ("teacher" script).
//
// Drives the live Groq model (llama-3.3-70b-versatile) through many simulated
// AAR conversations and saves (conversation -> final JSON) pairs as sharegpt
// JSONL, ready for QLoRA fine-tuning (see fine-tune/train.py).
//
// The conversation is teacher-driven: the model asks its questions one at a
// time and this script answers from a randomized template, so the dataset
// contains the model's real questions + the final JSON. ~8-15 API calls per
// example.
//
// Usage:
//   GROQ_API_KEY=your_key node scripts/generate-dataset.js --count 100 --out dataset.jsonl
//   (falls back to reading the key from config.js)

const fs = require("fs");
const path = require("path");

const GROQ_API_KEY = process.env.GROQ_API_KEY || readKeyFromConfig();
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TEACHER_MODEL = "llama-3.3-70b-versatile";

// Keep in sync with the system prompt embedded in index.html.
const SYSTEM_PROMPT = extractSystemPrompt();

function extractSystemPrompt() {
  try {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const m = html.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    if (!m) throw new Error("SYSTEM_PROMPT not found in index.html");
    return m[1];
  } catch (err) {
    console.error("Could not read SYSTEM_PROMPT from index.html:", err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Template pools
// ---------------------------------------------------------------------------

const TOPICS = [
  "eLGU systems onboarding and configuration",
  "Cybersecurity awareness for local government units",
  "Digital transformation roadmap workshop",
  "E-Government interoperability standards orientation",
  "Capacity building on the eLGU platform",
  "Data privacy and information security seminar",
  "Online service delivery training for LGU frontliners",
  "GIS and open data workshop for provincial staff",
  "E-Governance quick response and helpdesk training",
  "Digital literacy training for barangay officials"
];

const MODULES = [
  "eLGU platform navigation and workflows",
  "Data encoding and validation procedures",
  "Security best practices and password hygiene",
  "Troubleshooting common system issues",
  "Report generation and analytics",
  "Interoperability and data sharing protocols"
];

const NAMES = [
  "Juan Dela Cruz", "Maria Santos", "Pedro Reyes", "Ana Gonzales",
  "Carlo Lim", "Liza Fernandez", "Mark Villanueva", "Grace Torres",
  "Ramon Aquino", "Cynthia Bautista", "Nilo Ramos", "Divina Castro"
];

const OFFICES = [
  "DICT R2", "DICT Central Office", "DICT Regional Office 2",
  "Provincial Administrator's Office", "Municipal Mayor's Office",
  "City ICT Office"
];

const POSITIONS = [
  "IT Officer", "Project Development Officer", "Administrative Aide",
  "Municipal Administrator", "Provincial ICT Officer", "OIC, ICT Division"
];

const MODES = [
  "Face-to-Face", "Online via Zoom", "Hybrid (Face-to-Face and online)",
  "Online via Google Meet"
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ---------------------------------------------------------------------------
// Example template
// ---------------------------------------------------------------------------

function buildTemplate() {
  const nFac = rand(1, 8);
  const facilitators = [];
  for (let i = 0; i < nFac; i++) {
    facilitators.push({
      name: pick(NAMES),
      office: pick(OFFICES),
      gender: Math.random() < 0.5 ? "M" : "F"
    });
  }
  const ben = {
    ngas: { male: rand(0, 12), female: rand(0, 12) },
    lgus: { male: rand(0, 30), female: rand(0, 30) },
    sucs: { male: rand(0, 10), female: rand(0, 10) },
    others: { male: rand(0, 8), female: rand(0, 8) }
  };
  const month = rand(1, 12);
  const day = rand(1, 28);
  return {
    title: `Training on ${pick(TOPICS)}`,
    dateTime: `February ${day}-${day + 1}, 2026 | 9:00am - 5:00pm`,
    mode: pick(MODES),
    controlNo: `eLGU-R2-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-2026-S${rand(100, 999)}`,
    facilitators,
    beneficiaries: ben,
    rationaleAnswer: pick([
      "It was about improving digital services in LGUs.",
      "To capacitate LGU staff on the eLGU platform so they can serve constituents online.",
      "The activity aimed to strengthen ICT governance and data management in local government units."
    ]),
    highlightsAnswer: pick([
      "We discussed the eLGU modules and did hands-on exercises.",
      "Covered system orientation, data encoding, and troubleshooting. Participants practiced on test accounts.",
      "Main topics were security practices and the new workflow features; outcomes included faster processing times."
    ]),
    preparedBy: { name: pick(NAMES), position: pick(POSITIONS) },
    conformedBy: { name: pick(NAMES), position: pick(POSITIONS) }
  };
}

// Maps the teacher's question to the next canned user answer.
function buildAnswerer(t) {
  const queues = {
    title: [t.title],
    date: [t.dateTime],
    mode: [t.mode],
    control: [t.controlNo],
    facilitators: [String(t.facilitators.length), ...t.facilitators.map(f => `${f.name} / ${f.office} / ${f.gender}`)],
    beneficiaries: [`NGAs: ${t.beneficiaries.ngas.male} male, ${t.beneficiaries.ngas.female} female; LGUs: ${t.beneficiaries.lgus.male} male, ${t.beneficiaries.lgus.female} female; SUCs: ${t.beneficiaries.sucs.male} male, ${t.beneficiaries.sucs.female} female; Others: ${t.beneficiaries.others.male} male, ${t.beneficiaries.others.female} female`],
    rationale: [t.rationaleAnswer],
    highlights: [t.highlightsAnswer],
    prepared: [`${t.preparedBy.name}, ${t.preparedBy.position}`],
    conformed: [`${t.conformedBy.name}, ${t.conformedBy.position}`]
  };
  return (question) => {
    const q = question.toLowerCase();
    if (/how many|number of.*facilitator|facilitator.*count/.test(q)) return queues.facilitators.shift() || "done";
    if (/facilitator|name of facilitator|office of facilitator|gender of facilitator/.test(q)) return queues.facilitators.shift() || "done";
    if (/title|name of the activity|activity.*titled/.test(q)) return queues.title.shift() || "done";
    if (/date|time|when/.test(q)) return queues.date.shift() || "done";
    if (/mode|platform|location|where/.test(q)) return queues.mode.shift() || "done";
    if (/control/.test(q)) return queues.control.shift() || "done";
    if (/beneficiar|nga|lgu|suc|male|female|attendance|attendees/.test(q)) return queues.beneficiaries.shift() || "done";
    if (/rationale|about|purpose|objective/.test(q)) return queues.rationale.shift() || "done";
    if (/highlight|topic|module|discuss|outcome/.test(q)) return queues.highlights.shift() || "done";
    if (/prepared|who prepared|preparing officer/.test(q)) return queues.prepared.shift() || "done";
    if (/conform|approve/.test(q)) return queues.conformed.shift() || "done";
    return "done";
  };
}

// ---------------------------------------------------------------------------
// Teacher calls
// ---------------------------------------------------------------------------

async function teacherReply(messages) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: TEACHER_MODEL,
          max_tokens: 4000,
          temperature: 0.6,
          response_format: { type: "json_object" },
          messages
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error("Groq error " + res.status + ": " + (errData.error?.message || JSON.stringify(errData)));
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) throw new Error("Empty teacher response");
      return text;
    } catch (e) {
      const retryable = /429|5\d\d|ECONN|fetch failed|network|timeout/i.test(e.message || "");
      if (attempt < maxRetries - 1 && retryable) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
}

function isFinalJson(text) {
  const cleaned = String(text)
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  return cleaned.startsWith("{") && /"title"/.test(cleaned);
}

async function simulateOne() {
  const t = buildTemplate();
  const answer = buildAnswerer(t);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const maxTurns = 40;

  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await teacherReply(messages);
    messages.push({ role: "assistant", content: reply });

    if (isFinalJson(reply)) {
      return { messages };
    }
    const next = answer(reply);
    messages.push({ role: "user", content: next });
    if (next === "done") {
      // Give the model one more chance to wrap up before giving up.
      const last = await teacherReply(messages);
      messages.push({ role: "assistant", content: last });
      return { messages, incomplete: !isFinalJson(last) };
    }
  }
  return { messages, incomplete: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { count: 100, out: "dataset.jsonl", start: 0, delayMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count") args.count = parseInt(argv[++i], 10);
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--start") args.start = parseInt(argv[++i], 10);
    else if (argv[i] === "--delay") args.delayMs = parseInt(argv[++i], 10);
  }
  return args;
}

async function main() {
  if (!GROQ_API_KEY) {
    console.error("No GROQ_API_KEY. Set the env var or add it to config.js.");
    process.exit(1);
  }
  const { count, out, start, delayMs } = parseArgs(process.argv.slice(2));
  console.log(`Teacher: ${TEACHER_MODEL}`);
  console.log(`Generating ${count} examples -> ${out}`);

  const outPath = path.resolve(out);
  let wrote = 0;
  let incomplete = 0;

  for (let i = start; i < start + count; i++) {
    try {
      const { messages, incomplete: inc } = await simulateOne();
      if (inc) incomplete++;
      const line = JSON.stringify({ messages });
      fs.appendFileSync(outPath, line + "\n");
      wrote++;
      if (wrote % 10 === 0) {
        console.log(`  ${wrote}/${count} (incomplete so far: ${incomplete})`);
      }
    } catch (e) {
      console.error(`  example ${i} failed: ${e.message}`);
      // Back off on repeated failures (rate limits etc.)
      await new Promise(r => setTimeout(r, 5000));
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  console.log(`Done. ${wrote} examples written (${incomplete} marked incomplete).`);
  console.log("Next: python fine-tune/train.py --dataset " + out + " --base Qwen/Qwen3-8B");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
