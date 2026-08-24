# AAR Generator — Multi-Project Improvement Plan

**Goal:** Evolve the single-form AAR Generator into a multi-project platform for
DICT: multiple report templates, real user accounts, server-side persistence,
and hardened API usage.
**Deployment target:** Hostinger KVM 2 VPS (Node + nginx + MySQL).
Signature/approval workflow is **out of scope** per decision on 2026-08-23.

**Current state (updated 2026-08-24):**
- Vite + React app in `src/`; Node server serves the built `dist/` **and** the API
- Multi-template registry (`templates/<id>/template.json`) driving chat prompts,
  preview, PDF and RTF export
- MySQL persistence (users, sessions, reports, templates) with migrations;
  session-cookie auth with `encoder`/`admin` roles
- Groq key pool → xAI fallback proxy with streaming and per-user rate limiting
- Admin panel: personnel lists, template builder, per-template default logos

**Open items:** live verification of the logo endpoints (needs a dev-server
restart), audit log (5.3), then Phase 6 polish after rollout feedback.

---

## Phase 1 — Foundation: build system & code structure
*Do this first; everything else builds on it.*

| Task | Details |
|---|---|
| 1.1 Scaffold Vite + React project | ✅ Done — app lives in `src/`, built by Vite; `server.js` serves `dist/` (project root fallback in dev) |
| 1.2 Extract components | ✅ Done — `ChatPanel`, `ReportPreview`, `PdfRenderer`, `ProviderPicker`, `TemplatePicker`, `LoginPanel`, `MyReports`, `AdminPanel`, `TemplateBuilder`, `App` |
| 1.3 Extract shared logic | ✅ Done — `src/lib/`: report parsing/validation, templates, prompt generation, storage, images, presets |
| 1.4 Add test setup | ✅ Done — Vitest; 45 tests over `report.js` and `templates.js` (`npm test`) |

**Deliverable:** ✅ shipped.

## Phase 2 — Multi-template support (multi-project core)

| Task | Details |
|---|---|
| 2.1 Template config format | ✅ Done — `templates/<id>/template.json`; field list drives chat collection order, JSON shape and rendering |
| 2.2 Template registry | ✅ Done — `templates/index.json` served via `/api/templates`; client prefers server definitions |
| 2.3 Parameterize system prompt | ✅ Done — `buildSystemPrompt(template)` generates it from the field list |
| 2.4 PDF renderer per template | ✅ Done — template-driven HTML blocks paginated by the print-window engine (A4; see 8.5); RTF export too |
| 2.5 Template picker UI | ✅ Done — header dropdown; choice persisted per browser |

**Deliverable:** adding a new DICT project = drop a folder in `templates/`, no code change.

## Phase 3 — Persistence & reports storage

| Task | Details |
|---|---|
| 3.1 Database | ✅ Done — MySQL (`mysql2` pool) via `db.js`; tables `users`, `sessions`, `reports`, `templates`; SQL migrations in `db/migrations/` applied by `npm run migrate`; env-var config (`DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`) works on both XAMPP (dev) and the VPS |
| 3.2 Reports API | ✅ Done — REST under `/api/reports`: create/list/get/update/delete with per-user ownership; row stores conversation + report + photos JSON |
| 3.3 Client sync | ✅ Done — debounced autosave of the draft; 🗂️ My Reports view opens saved reports (admins see all with `?all=1`) |
| 3.4 Photo uploads | ✅ Done differently by decision — photos are compressed client-side and embedded as data URLs on the report row (no separate upload endpoint/disk store needed at current sizes) |

**Deliverable:** reports survive browser resets and are accessible from any machine.

## Phase 4 — Authentication & roles

| Task | Details |
|---|---|
| 4.1 Auth backend | ✅ Done — session cookies (`aar_sid`, HttpOnly), bcrypt hashes, register/login/logout/me endpoints; first account bootstraps the admin |
| 4.2 Roles | ✅ Done — `encoder` (own reports) / `admin` (templates, personnel, all reports) |
| 4.3 Protect APIs | ✅ Done — `/api/reports*`, template writes and logo uploads require login/admin; `/api/chat` rate-limited per user/IP (see 5.2) |
| 4.4 Login UI | ✅ Done — `LoginPanel`; header shows username + role |

**Deliverable:** multiple users can use the app concurrently without seeing each other's drafts.

## Phase 5 — Hardening & operations

| Task | Details |
|---|---|
| 5.1 Schema validation | ✅ Done — `validateRawLlmJson` + `validateReportSchema` (template-driven, `schema.js`) gate chat results and every server save; failures surface as a friendly chat message |
| 5.2 Rate limiting | ✅ Done — per-user/per-IP token bucket on `/api/chat` (`CHAT_RATE_MAX`, `CHAT_RATE_REFILL_MS`) |
| 5.3 Audit log | ⬜ Open — `audit_log` table: who generated/exported what, which provider/model answered. **Next up** |
| 5.4 Deployment doc | ✅ Done — `DEPLOYMENT.md`: Node app behind nginx (reverse proxy, SSE-safe), MySQL on the same VPS, systemd unit for `server.js`, HTTPS via certbot, env-var reference, update + backup procedures. The Vercel/serverless path (`api/chat.cjs`) is legacy-only |

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
| 7.1 Manual signatories | ✅ Done — person fields marked `"manual": true`; excluded from chat collection and the model's JSON schema |
| 7.2 Personnel dropdowns | ✅ Done — Preview tab shows dropdowns (+ editable free text) for each manual person field |
| 7.3 Progressive JSON | ✅ Done — cumulative ```json progress block after every reply; client merges it into the live preview |
| 7.4 Split view | ✅ Done — chat + live preview side by side (🪟 toggle), placeholder panel before data arrives |
| 7.5 Header/footer presets | ✅ Done — uploads land in a local gallery with re-pick dropdowns; superseded for defaults by 8.4 |

**Deliverable:** ✅ shipped — fewer Q&A rounds, visible live progress,
consistent personnel names across the office.

## Phase 8 — Administration & template management (opened 2026-08-24)

| Task | Details |
|---|---|
| 8.1 Personnel editor | ✅ Done — `⚙️ Admin` tab (admin role only): edit the predefined name/position list per template; stored in the DB `templates` table (`GET/PUT /api/templates/:id/personnel`), applied instantly for everyone |
| 8.2 Custom signatory fix | ✅ Done — PersonPicker always shows editable Name/Position fields below the dropdown; picking a list entry overwrites both, typing works at any time |
| 8.3 Template builder UI | ✅ Done — `⚙️ Admin → Templates`: guided form (name, opening question, standard/custom questions, beneficiary categories) + advanced raw-JSON mode; server validates and writes `templates/<id>/template.json` + `index.json`; appears in everyone's Template Picker instantly |
| 8.4 Default header/footer logos | ✅ Done — admins import a Header Logo and Footer Logo per template in the builder (`POST/DELETE /api/templates/:id/logo`, stored under `templates/<id>/`, referenced by `headerLogo`/`footerLogo` in template.json); everyone picking that template gets its branding automatically (per-session overrides still win); `aar-elgu` defaults to the DICT banner |
| 8.5 Proper A4 pagination | ✅ Done — print-window engine rewritten: accurate block measurement (`flow-root`), section headings never orphaned at a page bottom, oversized tables and photo collages split across pages by row/slot with repeated headers + "(continued)" labels; nothing is clipped |

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
- **"Booking rules" in settings** — raised 2026-08-24; no such feature exists
  in this app. Awaiting clarification: either it belongs to a different project,
  or it's a new feature (e.g. scheduling activities with capacity/conflict
  rules) that would be scoped here first.
