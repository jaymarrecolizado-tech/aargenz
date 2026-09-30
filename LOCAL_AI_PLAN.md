# Local AI Model Integration Plan

**Goal:** Let the AAR Generator swap its live cloud model (openai/gpt-oss-120b
via the Groq API) for a local, self-hosted model — including models that can be
fine-tuned so their output matches the live model's format and quality.

**Current integration (from `index.html`, `server.js`, `api/chat.js`):**

```
browser (chatCompletion in index.html)
  ├─ 1. POST /api/chat        → server.js / api/chat.js → routes to local model or Groq
  └─ 2. no proxy (file://)    → local model directly (Ollama etc.), then Groq fallback
```

The request body is already OpenAI-format (`model`, `messages`, `max_tokens`).
Note: `response_format: {type:"json_object"}` was dropped from all call sites
(2026-08) because the live model (Groq `openai/gpt-oss-120b`) rejects JSON mode
on question turns — it collects data one question at a time in prose and only
emits the final JSON at the end. That is still the key advantage: **every local
runtime below speaks the same OpenAI-compatible `/v1/chat/completions` API**,
so the swap is mostly a base-URL + model-name change.

---

## Implementation status

| Phase | What | Status |
|---|---|---|
| **1. Provider switch** | `AI_PROVIDER`/`LOCAL_*` config in `chatCompletion`, `server.js`, `api/chat.js`, `config.example.js`; `temperature: 0.2` | ✅ **Done** |
| **6. UX polish** | Provider/model dropdown in the header (persists to localStorage); `auto` = local first, Groq fallback | ✅ **Done** |
| **3. Data collection** | "📥 Dataset" button exports the current report as a sharegpt training example | ⚠️ **Button only** — the bulk generator `scripts/generate-dataset.js` was cut: it crashed on load (CommonJS in an ESM package) and read a `SYSTEM_PROMPT` constant `index.html` no longer has |
| **5. Eval harness** | `scripts/evaluate.js` replays conversations and scores JSON-validity + schema completeness using the app's own `extractJson`/`normalizeReport` | ✅ **Code done** |
| **4. Fine-tune** | `fine-tune/train.py` (Unsloth QLoRA → merged 16-bit + GGUF Q4_K_M) + `fine-tune/Modelfile.example` for Ollama | ✅ **Code done** (needs a GPU to run) |
| **2. Zero-shot trial** | Install Ollama, pull a model, point the app at it, run 10 real reports | ⏳ **Your turn** (needs hardware) |

**Getting started (once Ollama is installed):**
1. `ollama pull qwen3:14b` (or `qwen3:8b` on 8 GB VRAM)
2. Run the app: `node server.js` (server mode) — or `npm run dev` and open
   http://localhost:5173, then pick
   **Local** in the header dropdown (start Ollama with `OLLAMA_ORIGINS=*` for
   direct browser access)
3. Export a few reports with the "📥 Dataset" button and append them into one JSONL
4. Fine-tune: `python fine-tune/train.py --base Qwen/Qwen3-14B --dataset dataset.jsonl`
5. `ollama create aar-local -f fine-tune/Modelfile.example` and switch `LOCAL_MODEL=aar-local`

---

## 1. Architecture: provider abstraction

Add a provider switch at two levels (client config for file:// mode, env vars
for server mode). The existing `chatCompletion` already has a "try A, fall back
to B" shape — extend it to "try local → try Groq".

### Config surface

`config.js` (client, local mode) and environment (server mode):

```js
const CONFIG = {
  GROQ_API_KEY: "...",              // fallback / cloud mode
  AI_PROVIDER: "local",             // "local" | "groq" | "auto"
  LOCAL_BASE_URL: "http://localhost:11434/v1",  // Ollama default
  LOCAL_MODEL: "qwen3:14b",         // any model name served locally
  LOCAL_TIMEOUT_MS: 120000          // local models are slow on first token
};
```

Server env vars mirror this: `AI_PROVIDER`, `LOCAL_BASE_URL`, `LOCAL_MODEL`.

### Behavior

- `AI_PROVIDER: "local"` → call `LOCAL_BASE_URL/chat/completions` with
  `LOCAL_MODEL`. No auth header.
- `AI_PROVIDER: "groq"` → current behavior.
- `AI_PROVIDER: "auto"` → try local first, fall back to Groq on
  connect-error/timeout (per message) — best UX while iterating.

### Where the code changes

| File | Change |
|---|---|
| `index.html` `chatCompletion()` | Read `AI_PROVIDER`; if `local`/`auto`, POST to `LOCAL_BASE_URL` first with `model: LOCAL_MODEL`, then existing Groq path |
| `server.js` `/api/chat` | If `AI_PROVIDER=local`, forward to `LOCAL_BASE_URL` instead of Groq (keeps the key/browser clean, avoids CORS entirely in server mode) |
| `api/chat.js` | Same routing logic for the serverless deploy |
| `config.example.js` | Document the new keys |

### JSON-mode & determinism notes

- **JSON mode (optional, local only):** Ollama, LM Studio, and vLLM support
  `response_format: {type:"json_object"}` on their OpenAI-compatible endpoints
  (Ollama maps it to `format:"json"`; schema form is also available). The app
  currently omits it app-wide because gpt-oss-120b rejects it on question turns;
  a local fine-tuned model that emits JSON reliably can re-enable it per-provider
  if desired. The `extractJson()` / `normalizeReport()` safety net always stays.
- **Temperature:** send `temperature: 0.2` for more deterministic output.
- **CORS (client mode only):** the browser calling
  `http://localhost:11434` directly needs Ollama started with
  `OLLAMA_ORIGINS=*` (or `OLLAMA_ORIGINS=http://localhost:3000`). Running
  through `server.js` avoids this entirely — recommended.

### Optional UX

A small provider/model dropdown in the header (with a "Test connection"
button) that writes the chosen provider into `CONFIG`/localStorage.

---

## 2. Local runtimes (all OpenAI-compatible)

| Runtime | Install | Notes |
|---|---|---|
| **Ollama** | `ollama.com` | Simplest; one command per model; JSON mode built in; recommended default |
| **LM Studio** | `lmstudio.ai` | GUI + server; JSON schema support |
| **llama.cpp `llama-server`** | `github.com/ggml-org/llama.cpp` | For serving a fine-tuned GGUF directly |
| **vLLM** | `vllm.ai` | Production serving, batching; overkill for a single user |

---

## 3. Model recommendations ("what type of models can be trained")

Two questions are conflated: (a) which model to *run* locally, and (b) which
model to *fine-tune* so output matches the live one.

### Path 0 — identical output, no training (highest fidelity)

The live model is **openai/gpt-oss-120b** (Groq). Run the same weights locally:

- **OpenAI gpt-oss-120b** (Apache-2.0) → a 120B-class model, needs ~64 GB+
  RAM/VRAM. This is the *same model*, so output matches by definition — no
  dataset, no training. Only do the fine-tuning paths below if this hardware
  isn't available.

### Path 1 — fine-tune a smaller model to reproduce the output (budget)

Distill the live model's behavior into a smaller instruct model with QLoRA.
Recommended bases (verified landscape, mid-2026):

| Tier (hardware) | Base model to fine-tune | Why |
|---|---|---|
| CPU-only laptop | Qwen 3 4B / Phi-4-mini (3.8B), Q4 ≈ 3 GB | Fast enough; format can be nailed by fine-tuning |
| 8 GB VRAM | **Qwen 3 8B** / Llama 3.1 8B, Q4 ≈ 5–6 GB | Best quality-per-GB; QLoRA trains on 8 GB |
| 16 GB VRAM | **Qwen 3 14B** / Phi-4 14B / Gemma 3 12B, Q4 ≈ 9–10 GB | Recommended sweet spot for matching 70B output |
| 24–32 GB VRAM | **Mistral Small 3 (24B)** / Qwen3-30B-A3B, Q4 ≈ 14–18 GB | Closest prose quality to the 70B teacher |
| 64 GB RAM / multi-GPU | Llama 4 Scout (17B active) | MoE; strong, but big footprint — only if already owned |

Notes:
- **Qwen 3 / Qwen 3.5 small models are explicitly tuned for structured/JSON
  output**, which is exactly this task — prefer them as the fine-tune base.
- A fine-tuned 8–14B model will match the live model's **structure and field
  completeness** reliably; its *prose* (rationale/highlights paragraphs) will be
  good but not byte-identical. If formal prose quality matters most, go 14B+
  or Path 0.

---

## 4. Making the output the same: the fine-tuning recipe

The task is narrow and highly structured (chat → one JSON object), which is
ideal for distillation onto a small model.

### 4a. Build the dataset (3 sources, in order)

1. **Harvest the live app (real data).** The "📥 Dataset" button in the preview
   tab exports the current report as a sharegpt example
   `{messages: [system, ...conversation, finalJSON]}`. Append several exports
   into one JSONL.
2. **Synthetic distillation (bulk).** ⚠️ **Not built** — `scripts/generate-dataset.js`
   was cut (it could not run). Re-create it when a real corpus is wanted: drive the
   live Groq model as the *teacher* — for each randomized template (1–15
   facilitators, all beneficiary combinations, a list of DICT/eLGU topics,
   short vs. long answers, "done" shortcuts), record the full
   teacher-driven transcript → final JSON. Target: **500–2,000 examples.**
3. **Edge cases.** Missing values, zero beneficiaries, mixed-case gender,
   multiple facilitators, very long rationale — whatever the eval (below) fails.

Format each example as sharegpt-style messages using the **exact** system
message returned by `buildSystemPrompt(template)` in `src/lib/templates.js`,
the conversation as
user/assistant turns, and the final JSON as the last assistant turn. Include the
JSON schema in a fraction of examples.

### 4b. Train (QLoRA, consumer-friendly)

- **Tool:** `fine-tune/train.py` (Unsloth; free Colab T4 works for 7–8B;
  16 GB VRAM for 14B).
- **Settings (start):** LoRA `r=16–32`, `alpha=32`, target all-linear,
  `lr=2e-4` (cosine), **2–4 epochs**, `max_seq_len` 4096–8192 (conversations
  run long), packing on, `bf16`.
- **Export:** merge LoRA → export to **GGUF Q4_K_M** (Unsloth exports GGUF
  directly) → `ollama create aar-local -f fine-tune/Modelfile.example` → set
  `LOCAL_MODEL` to it. Iteration is a single `ollama create` + refresh.

### 4c. Evaluate (reuses existing code)

`scripts/evaluate.js` replays N held-out conversations against the local model
and checks, per response:

1. `extractJson()` succeeds (no markdown, no prose around the JSON)
2. `normalizeReport()` fills all required fields (schema completeness)
3. Counts are numeric; facilitators have name/office/gender; gender ∈ {M,F}
4. Prose check (optional): paragraph count / length similarity to the teacher

The app already has `extractJson` + `normalizeReport` — the eval harness is
just those functions run in a loop. Track pass-rate vs. the same conversations
on Groq (`--teacher`); add every failure case back into the dataset (4a-3) and
retrain.

---

## 5. Implementation roadmap

| Phase | Work | Effort |
|---|---|---|
| **1. Provider switch** | `AI_PROVIDER`/`LOCAL_*` config in `chatCompletion`, `server.js`, `api/chat.js`, `config.example.js`; `temperature: 0.2` | ✅ done |
| **2. Zero-shot trial** | Install Ollama, pull **Qwen 3 14B** (and/or 8B), point the app at it, run 10 real reports; measure JSON-validity + prose quality | ⏳ needs hardware |
| **3. Data collection** | Logging hook in `sendMessage` + "Download dataset" button; synthetic teacher script (Groq) generating 500–2,000 transcripts | ✅ code done |
| **4. Fine-tune** | Unsloth QLoRA on the chosen base (start 8B, compare 14B), export GGUF, serve via Ollama | ✅ code done (needs GPU) |
| **5. Eval + iterate** | Eval harness on held-out set; feed failures back into dataset; retrain until parity | ✅ code done |
| **6. UX polish** | Provider/model dropdown, connection test, latency indicator | ✅ dropdown done |

**Suggested default target:** Qwen 3 14B (Q4, ~10 GB) fine-tuned with QLoRA,
served by Ollama, `AI_PROVIDER: "auto"` so Groq remains the safety net.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fine-tuned 7–14B prose is weaker than 120B | Use 14B+ base; Path 0 (real gpt-oss-120b) if hardware exists |
| Local model latency on first token | `LOCAL_TIMEOUT_MS` generous; streaming (SSE) now implemented; "auto" fallback to Groq → OpenRouter |
| Conversations exceed small-model context | Keep `max_seq_len` ≥ 8192; shorten transcript history in training data |
| Dataset too small → format drift | Synthetic teacher data is cheap to generate; iterate until eval passes |
| Fine-tuning licensing | Qwen (Apache-2.0) and Mistral (Apache-2.0) are permissive; Llama 4 uses Meta's community license — check before commercial use |
