// End-to-end smoke test for the split server (plan 5.1).
//
// Boots against the live DB with a throwaway admin, exercises every route the
// refactor moved into server/routes/, and restores anything it touches on disk
// or in the DB. Run with the server already listening on :3000.
//
//   node server.js &
//   node scripts/smoke-api.js
//
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "../db.js";

const BASE = "http://localhost:3000";
const ADMIN = { username: "_smoke_admin", password: "smoketest123" };
const NEWPASS = "smoketest456";
const TPL = "aar-egov";            // no controlPrefix -> no sequence number burned
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let cookie = null;
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
};

async function call(method, urlPath, { body, cookie: c = cookie, headers = {}, rawBody } = {}) {
  const init = { method, headers: { ...headers } };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (c) init.headers["Cookie"] = c;
  const res = await fetch(BASE + urlPath, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, h: res.headers, setCookie: res.headers.getSetCookie?.() ?? [], text, json };
}
const cookieFrom = (setCookie) => {
  const line = setCookie.find(s => s.startsWith("aar_sid="));
  return line ? line.split(";")[0] : null;
};

const pool = getPool();
const cleanup = [];

try {
  // ---------------------------------------------------------------- fixtures
  await pool.query("DELETE FROM users WHERE username IN (?, ?)", [ADMIN.username, "_smoke_enc"]);
  const adminId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)",
    [adminId, ADMIN.username, await bcrypt.hash(ADMIN.password, 10), "admin"]
  );
  cleanup.push(async () => {
    await pool.query("DELETE FROM users WHERE username IN (?, ?)", [ADMIN.username, "_smoke_enc"]);
  });

  // ------------------------------------------------- A. headers + no-cookie
  const root = await call("GET", "/");
  check("GET / returns 200 html", root.status === 200 && /text\/html/.test(root.h.get("content-type") ?? ""), `status=${root.status} ct=${root.h.get("content-type")}`);
  check("security: X-Content-Type-Options nosniff", root.h.get("x-content-type-options") === "nosniff");
  check("security: X-Frame-Options DENY", root.h.get("x-frame-options") === "DENY");
  check("security: Referrer-Policy set", !!root.h.get("referrer-policy"), root.h.get("referrer-policy") ?? "");
  // CSP ships as Report-Only unless CSP_ENFORCE=1, so either header counts.
  const csp = root.h.get("content-security-policy") ?? root.h.get("content-security-policy-report-only");
  check("security: Content-Security-Policy present", !!csp, csp ? csp.slice(0, 40) + "..." : "");

  check("GET /api/auth/me anonymous -> null", (await call("GET", "/api/auth/me")).json === null);
  check("GET /api/reports anonymous -> 401", (await call("GET", "/api/reports")).status === 401);
  check("GET /api/users anonymous -> 401", (await call("GET", "/api/users")).status === 401);
  check("GET /api/audit anonymous -> 401", (await call("GET", "/api/audit")).status === 401);
  check("GET /api/ai/status anonymous -> 401", (await call("GET", "/api/ai/status")).status === 401);
  check("GET /api/templates/aar-egov anonymous -> 401", (await call("GET", "/api/templates/aar-egov")).status === 401);
  check("GET personnel anonymous -> 401", (await call("GET", `/api/templates/${TPL}/personnel`)).status === 401);
  check("POST logo anonymous -> 401", (await call("POST", `/api/templates/${TPL}/logo`, { body: { kind: "header", dataUrl: PNG } })).status === 401);

  // 405s
  check("DELETE /api/auth/login -> 405", (await call("DELETE", "/api/auth/login")).status === 405);
  check("GET /api/chat -> 405", (await call("GET", "/api/chat")).status === 405);
  check("DELETE /api/audit -> 405", (await call("DELETE", "/api/audit")).status === 405);
  check("POST /api/ai/status -> 405", (await call("POST", "/api/ai/status")).status === 405);
  // /api/reports checks auth before method, so anonymous is 401 — the 405 case
  // is asserted after login below.

  // ------------------------------------------------------------- B. auth
  // "wrong" is only 5 chars, so it would trip the length check (400) before the
  // credential check (401). Use a wrong-but-valid-length password.
  check("login bad password -> 401", (await call("POST", "/api/auth/login", { body: { username: ADMIN.username, password: "wrongpass" } })).status === 401);
  const login = await call("POST", "/api/auth/login", { body: ADMIN });
  check("login correct -> 200", login.status === 200 && login.json?.username === ADMIN.username, `status=${login.status}`);
  cookie = cookieFrom(login.setCookie);
  check("login sets aar_sid cookie", !!cookie);
  check("session cookie is HttpOnly", login.setCookie.some(s => s.startsWith("aar_sid=") && /HttpOnly/i.test(s)));

  const me = await call("GET", "/api/auth/me");
  check("GET /api/auth/me -> admin", me.json?.username === ADMIN.username && me.json?.role === "admin");

  // ------------------------------------------------------------ C. audit
  const auditGet = await call("GET", "/api/audit?limit=5");
  check("GET /api/audit -> entries", auditGet.status === 200 && Array.isArray(auditGet.json?.entries), `n=${auditGet.json?.entries?.length}`);
  check("GET /api/audit bad action -> 400", (await call("POST", "/api/audit", { body: { action: "nope" } })).status === 400);
  check("POST /api/audit export.pdf -> 200", (await call("POST", "/api/audit", { body: { action: "export.pdf", detail: "smoke" } })).status === 200);

  // --------------------------------------------------------- D. templates
  const list = await call("GET", "/api/templates");
  check("GET /api/templates -> 4 templates", list.status === 200 && Array.isArray(list.json) && list.json.length === 4, `n=${list.json?.length}`);

  const one = await call("GET", `/api/templates/${TPL}`);
  check(`GET /api/templates/${TPL} -> object`, one.status === 200 && one.json?.id === TPL);

  check("PUT template invalid -> 422", (await call("PUT", `/api/templates/${TPL}`, { body: { name: 1 } })).status === 422);

  // Round-trip a valid save, then restore the original bytes exactly.
  const tplFile = path.join("templates", TPL, "template.json");
  const tplBackup = fs.readFileSync(tplFile);
  const tplJson = JSON.parse(tplBackup.toString("utf8"));
  const putTpl = await call("PUT", `/api/templates/${TPL}`, { body: tplJson });
  check("PUT template valid -> 200", putTpl.status === 200, `status=${putTpl.status}`);
  fs.writeFileSync(tplFile, tplBackup);
  check("template.json restored byte-exact", Buffer.compare(fs.readFileSync(tplFile), tplBackup) === 0);

  const persGet = await call("GET", "/api/templates/aar-ilcdb/personnel");
  check("GET personnel -> seeded list", persGet.status === 200 && Array.isArray(persGet.json) && persGet.json.length === 1, `n=${persGet.json?.length}`);

  const [[egovRow]] = await pool.query("SELECT config FROM templates WHERE id = ?", [TPL]);
  const egovBackup = egovRow?.config ?? null;
  cleanup.push(async () => {
    if (egovBackup === null) await pool.query("DELETE FROM templates WHERE id = ?", [TPL]);
    else await pool.query("UPDATE templates SET config = ? WHERE id = ?", [egovBackup, TPL]);
  });
  const persPut = await call("PUT", `/api/templates/${TPL}/personnel`, { body: [{ name: "SMOKE TEST", position: "QA" }] });
  check("PUT personnel -> 200", persPut.status === 200, `status=${persPut.status}`);
  const persAfter = await call("GET", `/api/templates/${TPL}/personnel`);
  check("PUT personnel persisted", persAfter.json?.length === 1 && persAfter.json[0].name === "SMOKE TEST");

  // Logo upload/delete on a template that has no logo files.
  const logoPost = await call("POST", `/api/templates/${TPL}/logo`, { body: { kind: "header", dataUrl: PNG } });
  check("POST logo -> 200 url", logoPost.status === 200 && typeof logoPost.json?.url === "string", `url=${logoPost.json?.url}`);
  check("POST logo bad kind -> 400", (await call("POST", `/api/templates/${TPL}/logo`, { body: { kind: "side", dataUrl: PNG } })).status === 400);
  const logoDel = await call("DELETE", `/api/templates/${TPL}/logo?kind=header`);
  check("DELETE logo -> 200", logoDel.status === 200);
  check("logo file removed from disk", !fs.existsSync(path.join("templates", TPL, "header-logo.png")));

  // ------------------------------------------------------------- E. users
  const users = await call("GET", "/api/users");
  check("GET /api/users -> list", users.status === 200 && users.json.some(u => u.username === ADMIN.username));

  const enc = await call("POST", "/api/users", { body: { username: "_smoke_enc", password: "encoder123", role: "encoder" } });
  check("POST /api/users -> 201", enc.status === 201, `status=${enc.status}`);
  const encId = enc.json?.id;
  check("POST duplicate user -> 409", (await call("POST", "/api/users", { body: { username: "_smoke_enc", password: "encoder123" } })).status === 409);
  check("POST short password -> 400", (await call("POST", "/api/users", { body: { username: "_smoke_x", password: "123" } })).status === 400);
  check("GET missing user -> 404", (await call("GET", "/api/users/" + crypto.randomUUID())).status === 404);
  check("PUT user password -> 200", (await call("PUT", `/api/users/${encId}/password`, { body: { password: "encoder456" } })).status === 200);
  check("PUT user role -> 200", (await call("PUT", `/api/users/${encId}`, { body: { role: "admin" } })).status === 200);
  check("PUT user bad role -> 400", (await call("PUT", `/api/users/${encId}`, { body: { role: "wizard" } })).status === 400);
  check("PUT own role -> 400", (await call("PUT", `/api/users/${adminId}`, { body: { role: "encoder" } })).status === 400);
  check("DELETE own account -> 400", (await call("DELETE", `/api/users/${adminId}`)).status === 400);
  check("DELETE other user -> 200", (await call("DELETE", `/api/users/${encId}`)).status === 200);

  // ----------------------------------------------------------- F. reports
  check("PATCH /api/reports -> 405 (authed)", (await call("PATCH", "/api/reports")).status === 405);
  check("POST report no templateId -> 400", (await call("POST", "/api/reports", { body: {} })).status === 400);

  const repId = crypto.randomUUID();
  const created = await call("POST", "/api/reports", { body: { id: repId, templateId: TPL, title: "Smoke report", conversation: [], report: {} } });
  check("POST report -> 201 v1", created.status === 201 && created.json?.version === 1, `status=${created.status} v=${created.json?.version}`);
  cleanup.push(async () => { await pool.query("DELETE FROM reports WHERE id = ?", [repId]); });

  const dedupe = await call("POST", "/api/reports", { body: { id: repId, templateId: TPL, title: "Smoke report", report: {} } });
  check("POST same id -> 200 deduplicated", dedupe.status === 200 && dedupe.json?.deduplicated === true, `status=${dedupe.status}`);
  const [[repCount]] = await pool.query("SELECT COUNT(*) n FROM reports WHERE id = ?", [repId]);
  check("dedupe did not create a second row", repCount.n === 1);

  const rlist = await call("GET", "/api/reports");
  check("GET /api/reports -> includes new report", rlist.status === 200 && rlist.json.some(r => r.id === repId));
  check("GET /api/reports?all=1 -> 200", (await call("GET", "/api/reports?all=1")).status === 200);
  check("GET report missing -> 404", (await call("GET", "/api/reports/" + crypto.randomUUID())).status === 404);

  const rone = await call("GET", `/api/reports/${repId}`);
  check("GET report -> version present", rone.status === 200 && rone.json?.version === 1, `v=${rone.json?.version}`);
  check("GET report -> photos stripped", !("photos" in (rone.json ?? {})) && rone.json?.photos_count === 0);

  const put1 = await call("PUT", `/api/reports/${repId}`, { body: { title: "v2", version: 1 } });
  check("PUT v1 -> 200 v2", put1.status === 200 && put1.json?.version === 2, `status=${put1.status} v=${put1.json?.version}`);
  const putStale = await call("PUT", `/api/reports/${repId}`, { body: { title: "stale", version: 1 } });
  check("PUT stale v1 -> 409 version_conflict", putStale.status === 409 && putStale.json?.code === "version_conflict", `status=${putStale.status}`);
  const [[staleRow]] = await pool.query("SELECT title FROM reports WHERE id = ?", [repId]);
  check("stale write did not land", staleRow.title === "v2", `title=${staleRow.title}`);
  const put2 = await call("PUT", `/api/reports/${repId}`, { body: { title: "v3", version: 2 } });
  check("PUT v2 -> 200 v3", put2.status === 200 && put2.json?.version === 3, `v=${put2.json?.version}`);
  const putNoVer = await call("PUT", `/api/reports/${repId}`, { body: { title: "v4" } });
  check("PUT without version -> 200 v4 (legacy)", putNoVer.status === 200 && putNoVer.json?.version === 4, `v=${putNoVer.json?.version}`);
  check("PUT nothing -> 400", (await call("PUT", `/api/reports/${repId}`, { body: { version: 4 } })).status === 400);

  const photos0 = await call("GET", `/api/reports/${repId}/photos`);
  check("GET photos -> empty", photos0.status === 200 && Array.isArray(photos0.json?.photos) && photos0.json.photos.length === 0);
  const photosPut = await call("PUT", `/api/reports/${repId}/photos`, { body: { photos: [PNG] } });
  check("PUT photos -> 1 saved", photosPut.status === 200 && photosPut.json?.count === 1, `status=${photosPut.status} n=${photosPut.json?.count}`);
  const photos1 = await call("GET", `/api/reports/${repId}/photos`);
  check("GET photos -> 1 returned", photos1.json?.photos?.length === 1);
  check("photos stored in own table", (await pool.query("SELECT COUNT(*) n FROM report_photos WHERE report_id = ?", [repId]))[0][0].n === 1);
  check("photos not in reports row", (await pool.query("SELECT photos FROM reports WHERE id = ?", [repId]))[0][0].photos === null);

  const csv = await call("GET", "/api/reports?format=csv");
  check("GET reports?format=csv -> text/csv", csv.status === 200 && /text\/csv/.test(csv.h.get("content-type") ?? ""), csv.h.get("content-type") ?? "");
  check("csv has header row", csv.text.startsWith("id,owner_name,template_id"));

  check("DELETE report -> 200", (await call("DELETE", `/api/reports/${repId}`)).status === 200);
  check("GET deleted report -> 404", (await call("GET", `/api/reports/${repId}`)).status === 404);
  check("photos cascaded away", (await pool.query("SELECT COUNT(*) n FROM report_photos WHERE report_id = ?", [repId]))[0][0].n === 0);

  // ---------------------------------------------------------------- G. AI
  const ai = await call("GET", "/api/ai/status");
  check("GET /api/ai/status -> 200", ai.status === 200 && typeof ai.json?.providerMode === "string", `mode=${ai.json?.providerMode}`);
  check("ai status reports chain + breaker", Array.isArray(ai.json?.effectiveChain) && !!ai.json?.breaker, `chain=${JSON.stringify(ai.json?.effectiveChain)}`);

  const chatBad = await call("POST", "/api/chat", { rawBody: "not json" });
  check("POST /api/chat invalid JSON -> 400", chatBad.status === 400, `status=${chatBad.status}`);

  // ------------------------------------------------------------ H. static
  check("GET / -> 200", (await call("GET", "/")).status === 200);
  const spa = await call("GET", "/some/spa/route");
  check("SPA fallback serves html", spa.status === 200 && /text\/html/.test(spa.h.get("content-type") ?? ""), `ct=${spa.h.get("content-type")}`);
  check("GET /config.js -> 200 js", (await call("GET", "/config.js")).status === 200);
  check("unknown /api/* -> 404 not html", (await call("GET", "/api/definitely-not-a-route")).status === 404);

  // --------------------------------------------------------- I. 413 cap
  const big = "x".repeat(33 * 1024 * 1024);
  const over = await call("POST", "/api/audit", { rawBody: big, headers: { "Content-Type": "application/json" } });
  check("oversize body -> 413", over.status === 413, `status=${over.status}`);

  // ----------------------------------------------------------- J. password
  check("password change bad current -> 401", (await call("POST", "/api/auth/password", { body: { currentPassword: "nope", newPassword: NEWPASS } })).status === 401);
  check("password change same -> 400", (await call("POST", "/api/auth/password", { body: { currentPassword: ADMIN.password, newPassword: ADMIN.password } })).status === 400);
  const pw = await call("POST", "/api/auth/password", { body: { currentPassword: ADMIN.password, newPassword: NEWPASS } });
  check("password change -> 200", pw.status === 200, `status=${pw.status}`);
  const relogin = await call("POST", "/api/auth/login", { body: { username: ADMIN.username, password: NEWPASS } });
  check("login with new password -> 200", relogin.status === 200);
  const pwBack = await call("POST", "/api/auth/password", { body: { currentPassword: NEWPASS, newPassword: ADMIN.password } });
  check("password restored -> 200", pwBack.status === 200);

  // ------------------------------------------------------------ K. logout
  const out = await call("POST", "/api/auth/logout");
  check("logout -> 200", out.status === 200 && out.json?.ok === true);
  check("logout clears cookie", out.setCookie.some(s => s.startsWith("aar_sid=;")));
  check("after logout /api/reports -> 401", (await call("GET", "/api/reports", { cookie })).status === 401);

} catch (e) {
  console.error("\nHARNESS ERROR:", e);
  results.push({ name: "harness completed without throwing", ok: false, extra: e.message });
} finally {
  for (const fn of cleanup) { try { await fn(); } catch (e) { console.error("cleanup:", e.message); } }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:"); for (const f of failed) console.log("  -", f.name, f.extra); }
process.exit(failed.length ? 1 : 0);
