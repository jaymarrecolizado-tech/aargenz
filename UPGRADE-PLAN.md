# AAR Generator — Upgrade Plan

**Reviewed:** 2026-09-12
**Scope:** full read-through of `server.js`, `src/App.jsx`, `db/`, `templates/`, `scripts/`,
plus `Plan.md` / `LOCAL_AI_PLAN.md` / `DEPLOYMENT.md`.
**Status of prior work:** Phases 1–8 in `Plan.md` are genuinely shipped. This document
only covers what is *missing*, *fragile*, or *not yet built* — not a re-list of done work.

---

## 0. What the app is today (as-built snapshot)

A **chat-driven report generator for DICT Region 2**, built as a React SPA on a
hand-rolled Node HTTP server with MySQL behind it. The user answers questions in
chat; the model returns a cumulative JSON block after every turn; the client merges
it into a live preview; the finished report renders to an A4 print window (PDF) or RTF.

| Layer | Implementation |
|---|---|
| Frontend | React 18 + Vite, no router, no state library, no TypeScript |
| Backend | `server.js` — one 1,187-line `http.createServer` handler, all routes inline |
| Database | MySQL/MariaDB via `mysql2` pool; `users`, `sessions`, `templates`, `reports`, `audit_log`; 3 migrations, tracked in a `migrations` table |
| Auth | Session cookie `aar_sid` (HttpOnly, SameSite=Lax), bcrypt cost 10, roles `encoder`/`admin` |
| AI | Groq `openai/gpt-oss-120b` → xAI `grok-4.6` → optional local Ollama; key-pool rotation on 401/403/429; SSE streaming |
| Templates | 4 shipped (`aar-elgu`, `aar-egov`, `freewifi`, `aar-ilcdb`); JSON-driven fields, personnel, branding |
| Exports | Print-window PDF (custom A4 pagination engine), RTF, CSV, JSONL training dataset |
| Ops | systemd + nginx + certbot + nightly `mysqldump` cron (`DEPLOYMENT.md`) |
| Tests | Vitest, 2 files / ~45 tests — `report.js` and `templates.js` only |

**Verdict:** unusually mature for an in-house tool. The weak spots are not features —
they are the **edges**: unauthenticated-adjacent endpoints, unbounded request bodies,
data growth in the `reports` row, and the total absence of a review/approval step
that a government report process normally requires.

---

## 1. Priority matrix

| # | Item | Impact | Effort | Priority |
|---|---|---|---|---|
| 2.1 | Login throttling + failed-login audit | High | S | **P0** |
| 2.2 | `Secure` cookie + security headers | High | S | **P0** |
| 2.3 | Request body size cap | High | S | **P0** |
| 2.4 | Expired-session cleanup | Low | XS | **P0** |
| 2.5 | User self-service password change | Med | S | **P0** |
| 2.6 | Move photos out of the `reports` JSON row | High | M | **P0** |
| 2.7 | Optimistic concurrency on autosave | Med | M | **P1** |
| 2.8 | Autosave retry queue + unload guard | Med | S | **P1** |
| 3.1 | Approval / review workflow | High | L | **P1** |
| 3.2 | Auto-generated control numbers | High | M | **P1** |
| 3.3 | Admin dashboard / analytics | High | M | **P1** |
| 3.4 | Duplicate-report ("clone last activity") | Med | S | **P1** |
| 3.5 | Reports list: pagination, search, date filter | Med | M | **P1** |
| 3.6 | Daily/weekly email digest | Low | M | **P2** |
| 3.7 | **Offline AI contingency (local model)** | High | M | ✅ **done on `ds_intervention`** |
| 4.1 | Photo captions, reorder, EXIF strip | Med | M | **P2** |
| 4.2 | Accessibility pass | Med | S | **P2** |
| 4.3 | React ErrorBoundary | Med | XS | **P2** |
| 4.4 | Filipino / bilingual labels | Low | M | **P2** |
| 4.5 | Bulk PDF export (ZIP) | Med | M | **P2** |
| 5.1 | Split `server.js` into route modules | High (maintainability) | M | **P1** |
| 5.2 | Extract `App.jsx` CSS + header component | Med | S | **P2** |
| 5.3 | ESLint + Prettier | Med | S | **P1** |
| 5.4 | API-level integration tests | High | M | **P1** |
| 5.5 | CI workflow (test + build + lint) | Med | S | **P1** |
| 5.6 | JSDoc types on template/report shapes | Low | S | **P2** |

Effort key: XS = under an hour · S = an afternoon · M = a day or two · L = a week+

---

## 2. P0 — Security & reliability hardening

These are small, isolated changes with outsized risk reduction. All were verified
as **absent** in the codebase before this branch. Items **2.1–2.5 are
implemented on `ds_intervention`**; 2.6–2.8 remain open (they are P1 in the
matrix above and need a schema migration).

### 2.1 Login has no throttling, and failures aren't audited

`/api/auth/register` and `/api/auth/login` (`server.js:680`) run bcrypt against any
request that arrives. `/api/chat` is protected by a token bucket
(`allowChat`, `server.js:70`), but **auth is not** — the one endpoint that must be.
Over public HTTPS this is a credential-stuffing target, and there is no record of
failed attempts because `writeAudit` is only called on *success* (`server.js:735`).

- Reuse the existing bucket shape: key on `ip:<addr>` **and** `user:<name>`, tighter
  budget (e.g. 10 attempts / 15 min), with a small delay on failure.
- Add `auth.login_failed` to the audit whitelist with the attempted username.
- Surface repeated failures for one account in the admin audit tab.

### 2.2 Session cookie lacks `Secure`, and there are no security headers

`server.js:293` sets `Path=/; HttpOnly; SameSite=Lax; Max-Age=…` — no `Secure`, so the
cookie is still transmitted over plain HTTP. Nothing anywhere sets HSTS,
`X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`,
or a CSP (grep across the repo returns zero hits).

- Append `; Secure` when `process.env.NODE_ENV === "production"` (or a dedicated
  `COOKIE_SECURE=1`) so local XAMPP over http keeps working.
- Add the header block in `server.js` **and** mirror it in nginx — nginx alone won't
  cover the API if someone hits the Node port directly, and Node alone is easy to
  forget when a new route is added.
- CSP needs care: the app uses inline `<style>` in `App.jsx` and opens a print
  window, so start in report-only mode, then tighten.

### 2.3 Request bodies are unbounded

Both `readBodyJson` (`server.js:296`) and the inline report reader
(`server.js:790`) concatenate chunks with no ceiling. A single large POST can push
the Node process into an OOM and take the whole office offline. Since photos are
data URLs, the legit payloads *are* big — so pick a real number (e.g. 30 MB) and
return `413` past it.

### 2.4 Expired sessions are never deleted

Sessions are only removed on logout (`server.js:752`) and password reset
(`server.js:633`). Expiry is checked at read time (`expires_at > NOW()`), so the
table grows forever. Add a sweep on an interval alongside the existing bucket
cleanup at `server.js:65`.

### 2.5 Users cannot change their own password

Only `PUT /api/users/:id/password` exists, and it's admin-only. An encoder has no
way to rotate a password they think is compromised. Add
`POST /api/auth/password { currentPassword, newPassword }`, require the current
password, revoke other sessions, and audit it.

### 2.6 Photos live inside the `reports` row

`photos` is a JSON column on `reports` (migration `0002`), holding up to
`MAX_PHOTOS = 10` base64 JPEGs at 1280px / q0.85 — realistically **1.5–3 MB per
report**, as base64 (≈33% overhead) inside a `LONGTEXT` on MariaDB.

Consequences: every single-report `GET` and every autosave `PUT` ships megabytes;
`SELECT *` on the row drags the photos in even when the caller only wants the
report; backups balloon; and the pool's 10 connections get tied up on transfer
rather than query.

- New table `report_photos (report_id, seq, mime, bytes MEDIUMBLOB, caption)` or
  files under `uploads/<reportId>/`.
- New endpoints `GET/POST/DELETE /api/reports/:id/photos`; the report row keeps only
  a manifest (or nothing).
- Have the PDF renderer fetch photos lazily at export time instead of holding them
  in React state for the whole session.
- This is also the prerequisite for captions and thumbnails (4.1).

### 2.7 Autosave silently last-write-wins

`useEffect` at `App.jsx:168` PUTs the whole row (`title`, `status`, `conversation`,
`report`, `photos`) after an 800 ms debounce. Two tabs, or a laptop plus a desktop,
will overwrite each other with no warning. Add a `version` (or reuse `updated_at`)
to `reports`, send it with the PUT, return `409` on mismatch, and have the client
offer "reload theirs / keep mine".

### 2.8 Failed autosaves are dropped

On error the client only sets `syncState = "error"` (`App.jsx:192`) and shows
"Offline" in the header. There is no retry queue and no `beforeunload` guard — a user
on flaky office Wi-Fi can close the tab believing their work is safe. Queue the
failed payload, retry on `online` / next edit, and block unload while unsaved.

---

## 3. P1 — Workflow features the office will actually ask for

### 3.1 Approval / review workflow — revisit the deferred decision

`Plan.md` defers signature/conformance as out of scope (2026-08-23), with
`preparedBy` / `conformedBy` left as plain text. **This is the single biggest
functional gap.** A government AAR has a lifecycle: it is prepared, submitted,
reviewed, and approved — and once approved it must be an immutable record.

The schema is already 80% of the way there (`status ENUM('draft','final')`).

- Extend to `draft → submitted → approved | rejected`.
- Add `submitted_by/at`, `reviewed_by/at`, `remarks`.
- Reviewer queue in the admin panel: pending reports, open, approve/reject with a
  comment.
- **Lock the report on approval** — reject edits server-side, not just in the UI.
- Optionally render the approver's signature image into the PDF.
- Every transition is an audit entry (the audit table already exists).

### 3.2 Auto-generated control numbers

`controlNo` is currently *asked of the user* (`templates/aar-elgu/template.json:31`,
example `eLGU-R2-12-04-2025-S157`). This is a guaranteed source of duplicates and
typos across encoders, and it is trivially automatable.

- Add a `control_sequences` table keyed by `(template_id, year)` with an atomic
  `UPDATE … LAST_INSERT_ID()` increment.
- Admin-configurable prefix per template (e.g. `eLGU-R2`).
- Generate on report **creation**, not on export, so the number is reserved once.
- Show it read-only in the preview; keep an admin "override" escape hatch.
- Format: `<PREFIX>-<MM-DD-YYYY>-S<n>`.

### 3.3 Admin dashboard / analytics

The data is already in MySQL and there's a CSV export — but nobody wants to build a
pivot table to answer "how many activities did we run in December, and how many
beneficiaries did we reach?" A single admin tab with:

- Reports per month / per template / per encoder.
- Beneficiary totals: male vs. female, NGAs / LGUs / SUCs / Others.
- Facilitator leaderboard (who ran the most activities).
- Draft vs. final vs. approved funnel.

This directly serves the regional office's upward reporting and is cheap to build —
it's `GROUP BY` queries plus the chart library you already load. It also makes the
CSV export a secondary path rather than the primary one.

### 3.4 Duplicate report

Bulk generation (Phase 6.1) helps *after* a report is done, but the first data entry
is still repeated for near-identical activities — same facilitators, same venue,
recurring trainings. Add "Duplicate" in My Reports that copies everything except
`title`, `dateTime`, `controlNo` (and clears photos), then opens it as a new draft.

### 3.5 Reports list needs pagination, search, and a date filter

`GET /api/reports` (`server.js:847`) returns **every** row for the user (or every row
in the system for an admin with `?all=1`) with no limit. At a few hundred reports
that's already a slow tab; at a few thousand it's unusable, and the admin CSV export
has the same shape.

- `?limit` / `?offset` with a sane default, plus a total count.
- `?q=` against title, `?from=` / `?to=` against the activity date.
- Consider a generated/stored `activity_date` column — right now the date lives only
  as free text inside the report JSON, so it cannot be indexed or filtered.

### 3.6 Email digest (optional)

A nightly/weekly summary to the regional director: reports filed, pending approval,
beneficiary totals. Low urgency, but it's the natural companion to 3.3.

### 3.7 Offline AI contingency — ✅ implemented on `ds_intervention`

**The gap:** the whole app depends on cloud API credit. When every Groq/xAI key
returns `429`/`402`, encoders cannot produce reports *at all* — while the
deadline for those reports has not moved. The provider abstraction and local
model plumbing already existed (`LOCAL_AI_PLAN.md`), but `auto` put the local
model **first**, which is a fine-tune workflow, not a contingency, and nothing
detected "out of credit" as distinct from "throttled".

**What was built** (full detail in `LOCAL_AI_CONTINGENCY.md`):

| Piece | Detail |
|---|---|
| `AI_PROVIDER=contingency` | New mode: Groq → xAI → **local model last**. Cloud runs normal operation; the offline model is reached only when the cloud fails. |
| Credit-exhaustion breaker | `402`, or `429` whose body matches quota/credit/billing, is classified as *out of money* rather than throttled. That provider is skipped for `CONTINGENCY_COOLDOWN_MS` (15 min default). Tracked **per provider**, so a broke Groq does not block xAI. |
| Clear failure mode | If every cloud provider is broke and no local model is installed, the API returns a `503` naming the fix instead of a generic upstream error. |
| `GET /api/ai/status` (admin) | Provider mode, configured key counts, the **effective fallback chain right now**, a live local-endpoint probe, and breaker state. |
| Admin → **AI** tab | The same information in the UI, including "offline fallback ready" and a `ollama pull <model>` hint when the configured model is missing locally. |
| Model guidance | Hardware-tiered open-source model picks (CPU-only through 24 GB VRAM), Ollama setup, the `num_ctx` trap, and a quarterly offline drill. |
| Header dropdown | `Contingency` added as the first option; `config.example.js` now defaults to `contingency` with `qwen3:8b`. |

**Verified facts that shaped the design:** Ollama exposes an OpenAI-compatible
endpoint and supports JSON-schema grammar constraints (token-level valid JSON,
but 30–80% slower and the model never sees the schema); Ollama's default context
window is far smaller than this app's prompts need; Qwen's small models are
specifically tuned for structured output; and quantizing a large model too
aggressively performs *worse* than a smaller model at higher precision.

**Follow-up worth considering:** the drill in §5 of the contingency doc should be
scheduled, not just documented — a contingency nobody has tested is not one.

---

## 4. P2 — Quality of life

| Item | Notes |
|---|---|
| **4.1 Photo captions, reorder, EXIF strip** | `VALID_FIELD_TYPES` already includes `captions` (`server.js:147`), so the renderer partly expects it. Add drag-and-drop ordering and **strip EXIF on upload** — photos taken at government events routinely carry GPS coordinates, which is a privacy issue when the PDF is shared. |
| **4.2 Accessibility** | Header controls are emoji + `title` with no `aria-label` (`App.jsx:546–574`); no `:focus-visible` styling; the chat log isn't a live region so screen readers miss new messages. An afternoon's work, and it's a government deliverable. |
| **4.3 ErrorBoundary** | One render error blanks the whole app. Wrap `<App/>` in `main.jsx` with a boundary that offers "reload" and preserves the local draft. |
| **4.4 Filipino / bilingual labels** | UI strings are hardcoded English across every component. Extract to a single dictionary and add a `fil` locale — low effort if done before the component count grows further. |
| **4.5 Bulk PDF export** | Select N reports in My Reports → one ZIP of PDFs. Requires moving PDF generation server-side (currently a client print window), which is a larger change but also unlocks scheduled/automated reporting. |

---

## 5. Code health & developer experience

### 5.1 `server.js` needs splitting

1,187 lines, every route inline inside a single request handler, with shared helpers
(`sendJson`, `requireAdmin`, `writeAudit`) declared *inside* that handler. Adding an
endpoint means editing a file where route order matters for correctness. Move to
`server/routes/{auth,reports,templates,users,audit,chat}.js` plus
`server/middleware/{session,rateLimit,body}.js`, and keep `server.js` as wiring only.

This is the highest-leverage maintainability change in the repo — and 2.x/3.x above
add ~8 new endpoints, so doing it *before* those lands is much cheaper than after.

### 5.2 `App.jsx` needs the same treatment

858 lines: ~180 lines of inline `<style>`, a 90-line header toolbar, all branding
state, all autosave logic, and all chat orchestration in one component. Extract
`src/styles.css` and a `<HeaderBar/>` component at minimum.

`PdfRenderer.jsx` is 984 lines and is the highest-risk file in the repo — a
regression there silently breaks every export, and it has **no test coverage**.

### 5.3 No linter or formatter

No ESLint, no Prettier, no config of either. Add both with a `npm run lint` script;
`eslint-plugin-react-hooks` alone will catch real bugs in the `useEffect`
dependencies currently silenced by `// eslint-disable-next-line` at `App.jsx:144`
and `App.jsx:196`.

### 5.4 Tests stop at the library boundary

The ~45 tests cover `report.js` and `templates.js`. Nothing covers the HTTP API —
auth, ownership checks, validation rejection, the audit trail — which is where the
security-relevant logic lives. Add integration tests that boot the server against a
throwaway MySQL database and exercise: login failure, cross-user report access
(should 403), invalid report payload (should 422), CSV export scope, and the
admin-only guards.

### 5.5 No CI

There is no `.github/` directory. Add a workflow running `npm test`, `npm run build`,
and lint on push — three commands, and it makes 5.3/5.4 actually enforceable.

### 5.6 Types

No TypeScript, no `jsconfig.json`, no JSDoc on the template/report shapes. The
template schema is the core contract of this app and it's documented only by
example. JSDoc typedefs for `Template`, `TemplateField`, and `Report` would pay for
themselves immediately — or migrate incrementally with `checkJs`.

---

## 6. Explicitly *not* recommended

- **Don't move to TypeScript wholesale** — the app is stable and small; incremental
  JSDoc gets most of the benefit without a rewrite.
- **Don't add a client state library** (Redux/Zustand) — the current props-based
  structure is appropriate at this size.
- **Don't add a router** — tabs work; a router adds deep-linking but also a class of
  bugs the SPA fallback (`server.js:1169`) doesn't currently have to handle.
- **Don't split the DB into microservices or add Redis** — one VPS, one office. The
  in-memory bucket is fine; the note in `DEPLOYMENT.md:178` is correct.
- **Don't generate PDFs in the browser forever** — but don't rewrite it until 4.5
  actually needs server-side rendering.

---

## 7. Suggested sequencing

| Sprint | Contents | Rationale |
|---|---|---|
| **1** | 2.1 → 2.4 (all XS/S), 5.3 | Smallest possible diff for the largest risk reduction, plus a linter to keep the rest clean. |
| **2** | 5.1 (split `server.js`), 5.5 | Do this *before* adding endpoints, not after. |
| **3** | 2.5, 2.6, 2.7, 2.8 | Finish the data-integrity story; 2.6 unblocks 4.1. |
| **4** | 3.2, 3.4, 3.5 | Control numbers + clone + list filtering: immediate day-to-day time savings. |
| **5** | 3.1 | The approval workflow — largest feature, biggest organisational payoff, best done once the report lifecycle has settled. |
| **6** | 3.3, 4.1, 4.2, 4.3 | Reporting surface + polish. |
| **7** | 5.2, 5.4, 4.4, 4.5, 5.6 | Pay down the frontend and close the test gap. |

---

## 8. The three things to do first

If only three changes get made, make them these:

1. **2.1 + 2.2** — throttle `/api/auth/login`, add `Secure` and the security headers.
   Hours of work; closes the only real exposure on a public HTTPS endpoint.
   ✅ **Done on `ds_intervention`.**
2. **3.2** — auto-generated control numbers. Removes a manual error source that
   affects every single report the office produces. ⏳ Open.
3. **3.1** — the approval workflow. It is the difference between a report *generator*
   and a report *system of record*. ⏳ Open.

**Plus 3.7** — the offline AI contingency, which was added to this plan later and
is now implemented. It is the item that keeps the office *operating* rather than
merely *correct*.

---

## 9. Status on `ds_intervention` (2026-09-12)

| Item | State |
|---|---|
| 2.1 Login throttling + failed-login audit | ✅ implemented |
| 2.2 `Secure` cookie + security headers + CSP (report-only) | ✅ implemented |
| 2.3 Request body cap (32 MB, 413) | ✅ implemented |
| 2.4 Expired-session sweep | ✅ implemented |
| 2.5 Self-service password change (+ header modal) | ✅ implemented |
| 3.7 Offline AI contingency + `/api/ai/status` + Admin → AI tab | ✅ implemented |
| 2.6 Photos out of the `reports` row | ✅ implemented (`0004`, `migrate:photos`) |
| 2.8 Autosave retry queue + unload guard | ✅ implemented |
| 3.2 Automatic control numbers | ✅ implemented |
| 3.4 Duplicate report | ⚠️ works, but not to spec (see below) |
| 2.7 Optimistic concurrency on autosave | ⏳ open — **the last P0 item** |
| 3.1, 3.3, 3.5, 3.6, 4.x, 5.x | ⏳ open |

**3.4 correction.** The status table previously listed this as open, but
"Duplicate" has existed in `MyReports.jsx` since Phase 6.3 and works. It does
*not* match what §3.4 specifies, though: the spec asks the copy to reset
`title`, `dateTime`, `controlNo` and clear photos, whereas the implementation
copies everything and only appends " (copy)" to the title. The control number
*is* handled correctly — the server overwrites the copied `controlNo` with a
freshly issued one — so the gap is `dateTime` (the copy inherits the original's
activity date, which is how a report ends up filed under the wrong date) and
the photos (a duplicate carrying the original's documentation is arguably
misleading). Small fix, worth folding into whichever item comes next.


Items 2.6, 2.8 and 3.2 landed in `c357c4f`. Notes on the implementation:

- **2.6** — `report_photos` (MEDIUMBLOB, `ON DELETE CASCADE`) replaces the
  base64 data URLs that used to ride along with every autosave. `reports.photos`
  is deliberately kept as a **read fallback** so reports saved before the
  migration keep rendering; `npm run migrate:photos` backfills and clears it.
  Run that once per environment after deploying `0004`.
- **3.2** — the sequence is reserved with `LAST_INSERT_ID(expr)` on a single
  pooled connection, which is what makes concurrent creates collision-free
  (verified: 12 simultaneous creates → `S13`–`S24`, no duplicates). Templates
  opt in with `"auto": "controlNumber"` on a field plus a `controlPrefix`.
- **2.8** — report and photo saves share one retry queue, so "Saved" is only
  shown once both have landed. Photo failures previously only reached the
  console, which is how a user could close the tab believing photos were safe.

The one part of the plan that still needs a **deploy-time** action is the photo
backfill above. Everything else is code-only.

