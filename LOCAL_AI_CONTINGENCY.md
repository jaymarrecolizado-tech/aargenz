# Local AI Contingency — Offline Fallback for the AAR Generator

**Created:** 2026-09-12 · **Branch:** `ds_intervention`
**Companion to:** `LOCAL_AI_PLAN.md` (fine-tuning a local model to match the
cloud one). This document is narrower and more urgent: **what the office runs on
when the cloud token budget is limited or exhausted.**

---

## 1. The problem this solves

The generator normally calls Groq (`openai/gpt-oss-120b`) through a pool of API
keys, with xAI as a second cloud tier. That is excellent while credit lasts and
catastrophic when it doesn't: every key returns `429`/`402`, and **encoders
cannot produce reports at all**. Reports are a compliance deliverable, not a
nice-to-have — the work has a deadline regardless of the API bill.

The fix is an **open-source model running on local hardware** that the server
falls back to automatically. Once the model is downloaded there is **no
marginal cost**: 100 reports cost the same as 10,000, and nothing leaves the
machine.

### TL;DR

| Question | Answer |
|---|---|
| Which model? | **`qwen3:8b`** for most office machines (8 GB VRAM). `qwen3:14b` if you have 16 GB. |
| Which runtime? | **Ollama** — one command, OpenAI-compatible, JSON-schema support built in. |
| Which mode? | **`AI_PROVIDER=contingency`** — cloud first, local model last. |
| Does it need code changes? | No. The provider chain already existed; this branch adds the ordering, the credit breaker, and the status panel. |
| How do I know it's ready? | Admin → **AI** tab, or `GET /api/ai/status`. |

---

## 2. How the contingency chain works

`AI_PROVIDER` selects the routing order. Four modes exist:

| Mode | Order | Use it for |
|---|---|---|
| **`contingency`** | Groq → xAI → **local** | **Production.** Normal operation on the cloud; local only when credit runs out. |
| `auto` | **local** → Groq → xAI | Fine-tune iteration — you *want* the local model first to compare output. |
| `local` | local only | Fully air-gapped sites. Errors if the local server is down. |
| `groq` | Groq → xAI | Cloud only (previous behaviour). |

### The credit breaker

Retrying the next API key is pointless when the *account* is out of money rather
than merely rate-limited. The proxy distinguishes the two:

- **429 with a quota/credit/billing body, or 402** → this provider is broke.
  Its breaker opens for `CONTINGENCY_COOLDOWN_MS` (default **15 min**) and every
  request in that window skips it entirely and lands on the local model.
- **429 without those signals, or 401/403** → ordinary throttling or a bad key.
  The next key in the pool is tried, exactly as before.

Breakers are **per provider**: Groq running dry says nothing about xAI's balance,
so a broke Groq does not stop xAI from being tried. When every cloud provider is
open *and* no local model is installed, the API returns a clear `503` naming the
fix rather than a generic upstream error.

Nothing is hidden: the provider that actually answered each chat is already
recorded in the audit log (`chat` rows carry `provider` + `model`), so you can
see exactly when the office switched to the offline model.

---

## 3. Which local model to run

Recommendations verified against the current (2026) local-model landscape. The
task here is narrow and highly structured — *chat → one JSON object* — so
**structured-output ability matters far more than general chat quality.**

### Pick by hardware

| Your hardware | Model | Quant | Footprint | Notes |
|---|---|---|---|---|
| **CPU only**, 8 GB RAM | `phi4-mini` (3.8B) | Q4_K_M | ~2.8 GB | Slowest acceptable (~3–5 tok/s). Genuine last resort. |
| **4 GB VRAM** | `qwen3:4b` | Q4_K_M | ~3.0 GB | Basic. Rely on the JSON grammar constraint. |
| **8 GB VRAM** (RTX 3060/4060, Apple M1) | **`qwen3:8b`** | Q5_K_M | ~6.2 GB | **The sweet spot** — 12–18 tok/s, best quality per GB. Start here. |
| 8 GB VRAM, want more reasoning | `mistral-small:24b` | Q3_K_M | ~7.5 GB | 24B depth survives the harsher quant; slower. |
| **16 GB VRAM** (RTX 4080, M2 Pro) | **`qwen3.6:27b`** | Q4_K_M | ~17 GB | ~GPT-4o-mini on MMLU-Pro. Best quality-for-effort. |
| 16 GB VRAM, MoE option | `qwen3.6:35b-a3b` | UD-Q4_K_M | ~22 GB | Fits a 16 GB card via llama.cpp `--cpu-moe`; strongest structured output in this tier. |
| **24 GB VRAM** (RTX 4090/3090) | `qwen3.5:72b` | Q4_K_M | ~22 GB | Ceiling of consumer hardware. |

> Exact Ollama tags move between releases — check `ollama.com/library` and use
> whatever the current tag is for the size you picked. The sizes above are the
> stable part.

### Two rules that matter more than the table

1. **Prefer a smaller model at higher precision over a bigger model at lower
   precision.** A 32B at Q2 performs *worse* than the same family at 8B Q5.
   Quantization damage scales with model size — never go below Q4 unless forced.
2. **Stay in the Qwen family if you can.** Qwen's small models are explicitly
   tuned for structured/JSON output, which is exactly this workload. Gemma and
   Phi are reasonable fallbacks; Llama 3.1 8B noticeably struggles with nested
   schemas.

### What degrades vs. the cloud model

Be honest with users about the trade:

- **Structure and field completeness**: reliable. The report JSON comes out
  complete and schema-valid, and the app's `validateReportSchema` gate still
  rejects anything malformed.
- **Prose quality** (the rationale / highlights paragraphs): good but
  noticeably flatter than a 120B model. Expect more editing before export.
- **Speed**: 12–18 tok/s on an 8 GB card versus near-instant cloud streaming. A
  long report may take a minute or two.

If prose quality matters most and you have the hardware, running the *same*
`gpt-oss-120b` weights locally (~64 GB RAM/VRAM) gives byte-identical output
with no training — see `LOCAL_AI_PLAN.md` §"Path 0".

---

## 4. Setup (Ollama, ~10 minutes)

### 4.1 Install and pull a model

```bash
# 1. Install Ollama from ollama.com (Windows/macOS/Linux), then:
ollama pull qwen3:8b          # or the size your hardware supports

# 2. Confirm it serves the OpenAI-compatible API:
curl http://localhost:11434/v1/models
```

### 4.2 Point the app at it

Set these on the server (environment, or `config.js` locally):

```bash
AI_PROVIDER=contingency
LOCAL_BASE_URL=http://localhost:11434/v1
LOCAL_MODEL=qwen3:8b
LOCAL_TIMEOUT_MS=180000      # local models are slow on the first token
```

Then restart the service and open **Admin → AI**. You should see
*"Offline fallback ready"*.

### 4.3 Raise the context window — this one bites everyone

**Ollama's default context is much smaller than this app needs.** The system
prompt plus a full report conversation easily exceeds 8k tokens, and a truncated
context makes the model lose the schema mid-conversation and drift.

Either set it per model with a `Modelfile`:

```
FROM qwen3:8b
PARAMETER num_ctx 16384
```

```bash
ollama create aar-local -f Modelfile
# then set LOCAL_MODEL=aar-local
```

…or export `OLLAMA_CONTEXT_LENGTH=16384` on the Ollama host.

### 4.4 (Only if the browser talks to Ollama directly)

Server mode never needs this — the proxy avoids CORS entirely. For `file://`
usage, start Ollama with `OLLAMA_ORIGINS=*`.

---

## 5. Verifying it actually works — the offline drill

**Run this once per quarter, and before any period where credit might lapse.**
A contingency you have never tested is not a contingency.

1. Open **Admin → AI** and confirm *"Offline fallback ready"*.
2. Set `AI_PROVIDER=local` (or ask an admin to pick **Local** in the header
   dropdown) to simulate a total cloud outage.
3. Generate **one complete report end-to-end** — chat through to a PDF export.
4. Confirm the JSON validated and the PDF paginates correctly (the export path
   is client-side, so it works offline too).
5. Switch back to `contingency`.

Better still, rehearse the *real* failure: temporarily set a deliberately invalid
`GROQ_API_KEYS` value. The proxy should exhaust the pool, trip nothing (401 is
throttling, not credit), and fall through to the local model — which is exactly
the behaviour you want when a key is rotated badly.

---

## 6. Local-model gotchas specific to this app

| Symptom | Cause | Fix |
|---|---|---|
| Report data comes back empty or garbled | A **thinking/reasoning** model is emitting its chain of thought, and it lands in the same field the app parses for JSON. | Use a non-thinking model, or disable thinking — for Gemma 4 pass `enable_thinking=false`; in Ollama set the `think: false` option. |
| Turns time out on a big model | Ollama's **JSON-schema grammar constraint slows generation 30–80%** (roughly half speed). | Raise `LOCAL_TIMEOUT_MS` to 180000–300000, or use `LOCAL_JSON_MODE=0` and lean on the app's `extractJson` safety net instead. |
| Model loses the schema partway through | Context window too small (see 4.3). | `num_ctx 16384`. |
| Valid JSON but wrong/missing *content* | Ollama's grammar constraint only guarantees **syntax** — the model never actually sees the schema. | Keep the schema in the system prompt (the app already does). Don't remove it thinking the grammar covers you. |
| Output varies between identical runs | Temperature. | The app already sends `temperature: 0.2`; `0` is fully deterministic if you need it. |
| First response takes ages, later ones are fast | Model loading into VRAM. | Expected. Keep the model warm, or accept the one-off cost. |

`LOCAL_JSON_MODE=1` forces `response_format: {type:"json_object"}` on local calls
only — cloud models reject it on prose question turns, which is why it is never
applied to them. Turn it on once you have confirmed your chosen model handles it.

---

## 7. Licensing

All models recommended above are permissively licensed for government use:

- **Qwen** — Apache 2.0
- **Gemma** — Apache 2.0 (Google's Gemma terms)
- **Phi** — MIT
- **Mistral Small** — Apache 2.0

Llama 4 uses Meta's community license — read it before commercial deployment.

---

## 8. Configuration reference

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | env / `config.js` | `auto` | `contingency` \| `auto` \| `local` \| `groq` |
| `LOCAL_BASE_URL` | env / `config.js` | `http://localhost:11434/v1` | Local OpenAI-compatible endpoint |
| `LOCAL_MODEL` | env / `config.js` | `qwen3:14b` | Model name served locally |
| `LOCAL_TIMEOUT_MS` | env / `config.js` | `120000` | Local request timeout |
| `LOCAL_JSON_MODE` | env / `config.js` | off | Force `json_object` on local calls |
| `CONTINGENCY_ENABLED` | env (server) | `1` | Set `0` to disable the credit breaker |
| `CONTINGENCY_COOLDOWN_MS` | env (server) | `900000` (15 min) | How long a broke provider stays skipped |
| `AUTH_RATE_MAX` | env (server) | `10` | Sign-in attempts per window, per IP and per username |
| `AUTH_RATE_WINDOW_MS` | env (server) | `900000` (15 min) | Sign-in throttle window |
| `MAX_BODY_BYTES` | env (server) | `33554432` (32 MB) | Largest accepted request body |
| `COOKIE_SECURE` | env (server) | auto on `NODE_ENV=production` | Adds `Secure` to the session cookie + HSTS |
| `CSP_ENFORCE` | env (server) | off (report-only) | Enforce the Content-Security-Policy |

---

## 9. Related work

- `LOCAL_AI_PLAN.md` — fine-tuning a local model so its output *matches* the
  cloud model (dataset generation, QLoRA, eval harness). Do that if the
  contingency model's prose quality proves insufficient in practice.
- `UPGRADE-PLAN.md` §3.7 — where this sits in the wider upgrade roadmap.
- `DEPLOYMENT.md` — production environment and service setup.
