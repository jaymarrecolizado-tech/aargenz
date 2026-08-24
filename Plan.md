# AAR Generator — Multi-Project Improvement Plan

**Goal:** Evolve the single-form AAR Generator into a multi-project platform for
DICT: multiple report templates, real user accounts, server-side persistence,
and hardened API usage.
**Deployment target:** Hostinger KVM 2 VPS (Node + nginx + MySQL).
Signature/approval workflow is **out of scope** per decision on 2026-08-23.

**Current state (baseline):**
- Single-page React app in `index.html` (1,362 lines, Babel-in-browser)
- One hardcoded template (`AAR-template.pdf`) + one system prompt
- State only in `localStorage`; no users, no DB, no tests
- Node proxy (`server.js`, `api/chat.js`) with Groq/xAI key pools + local model support

---

## Phase 1 — Foundation: build system & code structure
*Do this first; everything else builds on it.*

| Task | Details |
|---|---|
| 1.1 Scaffold Vite + React project | Move app out of `index.html` into `src/`. Keep `server.js` as dev/static server or switch to Vite dev server + proxy |
| 1.2 Extract components | Split into: `ChatPanel`, `ReportPreview`, `PdfRenderer`, `ProviderPicker`, `App`. Keep behavior identical (regression-check against current app) |
| 1.3 Extract shared logic | `extractJson`, `normalizeReport`, `SYSTEM_PROMPT` → `src/lib/` so they can be reused by scripts and tests |
| 1.4 Add test setup | Vitest + unit tests for `extractJson` / `normalizeReport` / schema validation (these also feed the eval harness) |

**Deliverable:** same app, modern build, zero behavior change, `npm run test` green.

## Phase 2 — Multi-template support (multi-project core)

| Task | Details |
|---|---|
| 2.1 Template config format | `templates/<id>/template.json`: `{ id, name, pdfTemplate, fields[], systemPrompt, beneficiaries?: {...} }` — field list drives both chat collection order and PDF mapping |
| 2.2 Template registry | `templates/index.json` lists available templates; loaded via `/api/templates` (server) so new projects need no client redeploy |
| 2.3 Parameterize system prompt | Move `SYSTEM_PROMPT` from code into each template's config; prompt is generated from the field list |
| 2.4 PDF renderer per template | Generalize the canvas/pdf render path to map template fields → PDF coordinates defined in `template.json` |
| 2.5 Template picker UI | Header dropdown (next to provider picker); selected template persisted in localStorage and sent with each request |

**Deliverable:** adding a new DICT project = drop a folder in `templates/`, no code change.

## Phase 3 — Persistence & reports storage

| Task | Details |
|---|---|
| 3.1 Database | **MySQL** (`mysql2` driver, connection pool) via `db.js` — target host is the Hostinger KVM 2 VPS. Tables: `users`, `sessions`, `reports`, `templates` (metadata only). Schema managed with SQL migration files (`db/migrations/*.sql`) applied by a small `npm run migrate` script. Connection settings via env vars (`DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`) — XAMPP's MySQL works for local dev since the project already lives in `htdocs` |
| 3.2 Reports API | REST endpoints under `/api/reports`: create, list (own reports), get, update, delete. Report row stores conversation JSON + normalized report JSON + template id. **Done** |
| 3.3 Client sync | Autosave draft to server (in addition to localStorage fallback); "My Reports" list view with open/duplicate/delete. **Restored by decision 2026-08-23 — implement after Phase 4 so drafts are owned by real user ids** |
| 3.4 Photo uploads | `POST /api/reports/:id/photos` → stored on disk (`data/uploads/`) and referenced from the report record |

**Deliverable:** reports survive browser resets and are accessible from any machine.

## Phase 4 — Authentication & roles

| Task | Details |
|---|---|
| 4.1 Auth backend | Session-cookie auth: register/login endpoints, bcrypt password hashes, secure httpOnly cookies. Optional: tie into existing DICT accounts/AD later |
| 4.2 Roles | `encoder` (create/edit own reports), `admin` (manage users + templates, see all reports). No approver role yet (signature flow deferred) |
| 4.3 Protect APIs | `/api/reports*` require auth; `/api/chat` rate-limited per user |
| 4.4 Login UI | Simple login page; header shows current user + role |

**Deliverable:** multiple users can use the app concurrently without seeing each other's drafts.

## Phase 5 — Hardening & operations

| Task | Details |
|---|---|
| 5.1 Schema validation | Zod schema per template validates final LLM JSON before save/PDF; user-friendly error surface in chat when validation fails |
| 5.2 Rate limiting | Per-user/per-IP token bucket on `/api/chat` (protects the Groq key pool) |
| 5.3 Audit log | `audit_log` table: who generated/exported what, which provider/model answered |
| 5.4 Deployment doc | Primary target: **Hostinger KVM 2 VPS** — Node app behind nginx (reverse proxy), MySQL on the same VPS, systemd service for `server.js`, HTTPS via Let's Encrypt; env var reference in README. Drop the Vercel/serverless path (`api/chat.js`) once the VPS is live |

**Deliverable:** safe for real office-wide use.

## Phase 6 — Polish (optional, after rollout)

- Bulk generation (multiple activities in one session)
- Export reports list to Excel/CSV for monitoring
- Dark mode / mobile layout pass
- Re-enable JSON mode per-provider for fine-tuned local models (ties into `LOCAL_AI_PLAN.md`)

## Phase 7 — Live preview & token-efficient collection (agreed 2026-08-24)

Artifact-style UX: the report preview fills in live while still chatting, and
the AI stops collecting data that users can pick faster themselves.

| Task | Details |
|---|---|
| 7.1 Manual signatories | Person fields (`preparedBy`, `conformedBy`) marked `"manual": true` in `template.json`; excluded from chat collection AND from the JSON schema the model is shown → fewer prompt + output tokens |
| 7.2 Personnel dropdowns | `template.json` gains `"personnel": [{ name, position }]`; Preview tab shows dropdowns (+ free-text fallback) for each manual person field |
| 7.3 Progressive JSON | System prompt instructs the model to append a fenced ```json block with all fields confirmed *so far* after every reply; client extracts it, merges, and updates the preview live |
| 7.4 Split view | Chat on the left, live preview on the right (toggleable); placeholder panel before any data arrives |
| 7.5 Header/footer presets | Uploaded headers/footers are saved to a local gallery; a picker reuses them instead of re-uploading every report |

**Deliverable:** fewer Q&A rounds and tokens per report; visible progress like
Claude artifacts; consistent personnel names across the office.

## Phase 8 — Administration & template management (opened 2026-08-24)

| Task | Details |
|---|---|
| 8.1 Personnel editor | ✅ Done — `⚙️ Admin` tab (admin role only): edit the predefined name/position list per template; stored in the DB `templates` table (`GET/PUT /api/templates/:id/personnel`), applied instantly for everyone |
| 8.2 Custom signatory fix | ✅ Done — PersonPicker always shows editable Name/Position fields below the dropdown; picking a list entry overwrites both, typing works at any time |
| 8.3 Template builder UI | ✅ Done — `⚙️ Admin → Templates`: guided form (name, opening question, standard/custom questions, beneficiary categories) + advanced raw-JSON mode; server validates and writes `templates/<id>/template.json` + `index.json`; appears in everyone's Template Picker instantly |
| 8.4 Default header/footer logos | ✅ Done — admins import a Header Logo and Footer Logo per template in the builder (`POST/DELETE /api/templates/:id/logo`, stored under `templates/<id>/`, referenced by `headerLogo`/`footerLogo` in template.json); everyone picking that template gets its branding automatically (per-session overrides still win); `aar-elgu` defaults to the DICT banner |

---

## Suggested order & effort

| Phase | Depends on | Rough effort |
|---|---|---|
| 1. Foundation | — | 1–2 sessions |
| 2. Multi-template | P1 | 2–3 sessions |
| 3. Persistence | P1 | 1–2 sessions |
| 4. Auth | P3 | 1–2 sessions |
| 5. Hardening | P3, P4 | 1 session |
| 6. Polish | rollout feedback | as needed |

Phases 2 and 3 could run in parallel after Phase 1.

## Deferred (explicitly out of scope)

- **Signature / conformance workflow** — digital signing and approver routing
  (deferred by decision; `preparedBy`/`conformedBy` remain plain text fields)
