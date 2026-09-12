// Chat proxy. Streams from Groq, xAI or the local contingency model, with the
// fallback chain and credit breaker described in LOCAL_AI_CONTINGENCY.md.
//


import path from "node:path";
import { AI_PROVIDER, GROQ_KEYS, GROQ_MODEL, XAI_KEYS, XAI_MODEL, XAI_URL, LOCAL_BASE_URL, LOCAL_MODEL, LOCAL_JSON_MODE, UPSTREAM_TIMEOUT_MS } from "../config.js";
import { cloudBreakerOpen, noteCloudCreditFailure, CLOUD_PROVIDERS } from "../lib/contingency.js";
import { allowChat } from "../middleware/rateLimit.js";

// Key-pool rotation cursors. Only /api/chat advances them.
let groqKeyCursor = 0;
let xaiKeyCursor = 0;

export async function handleChat(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    }

    const chatUser = await getSessionUser(req);
    const bucketKey = chatUser ? `u:${chatUser.id}` : `ip:${req.socket.remoteAddress}`;
    if (!allowChat(bucketKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Too many requests — please wait a moment before trying again" } }));
    }

    const provider = (body && body.provider) || AI_PROVIDER;
    const wantsStream = !!(body && body.stream);
    const messages = (body && body.messages) || [];
    const makeBody = (model) => JSON.stringify({
      model,
      max_tokens: (body && body.max_tokens) || 4000,
      temperature: 0.2,
      // Phase 6: opt-in strict JSON output, local model ONLY (fine-tuned
      // models that always answer with a single JSON object). Cloud providers
      // never get response_format — json_object breaks their prose questions.
      // Enabled via env LOCAL_JSON_MODE=1 or the client sending jsonMode:true.
      response_format: provider === "local" && (body?.jsonMode === true || LOCAL_JSON_MODE)
        ? { type: "json_object" }
        : undefined,
      stream: wantsStream || undefined, // omitted when false
      messages
    });

    // Candidate pools. The local model is built once and then placed in the
    // chain according to the provider mode (see the `phases` list below):
    //   local       → local only
    //   auto        → local first, cloud fallback
    //   contingency → cloud first, LOCAL LAST RESORT
    const localCandidate = LOCAL_MODEL ? {
      url: LOCAL_BASE_URL + "/chat/completions",
      body: makeBody(LOCAL_MODEL),
      headers: { "Content-Type": "application/json" },
      label: "local model",
      model: LOCAL_MODEL
    } : null;

    let groqCandidates = [];
    let xaiCandidates = [];
    let localCandidates = [];
    if (provider === "local") {
      if (!localCandidate) {
        return sendJson(500, { error: { message: "LOCAL_MODEL is not set on the server" } });
      }
      localCandidates = [localCandidate];
      groqCandidates = localCandidates; // the single-phase path below reads this
    } else {
      if ((provider === "auto" || provider === "contingency") && localCandidate) {
        localCandidates = [localCandidate];
      }
      if (!GROQ_KEYS.length && !XAI_KEYS.length && !localCandidates.length) {
        return sendJson(500, {
          error: {
            message: "No AI provider configured. Set GROQ_API_KEY / GROQ_API_KEYS " +
              "(or XAI_API_KEY / XAI_API_KEYS) in the environment or config.js, or install a " +
              "local model — see LOCAL_AI_CONTINGENCY.md."
          }
        });
      }
      groqCandidates = GROQ_KEYS.map(key => ({
        url: "https://api.groq.com/openai/v1/chat/completions",
        body: makeBody(GROQ_MODEL),
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        label: "Groq",
        model: GROQ_MODEL
      }));
      xaiCandidates = XAI_KEYS.map(key => ({
        url: XAI_URL,
        body: makeBody(XAI_MODEL),
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        label: "xAI",
        model: XAI_MODEL
      }));
    }

    // Abort the upstream request if the client disconnects; add a hard timeout
    // for buffered (non-streaming) requests only.
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const timer = wantsStream ? null : setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      let upRes = null;
      let chosenCand = null; // the candidate that ultimately answered
      let lastErr = null;
      let lastKeyErr = null; // { status, text } of the last rate-limited/rejected key
      let allKeyIssues = true;

      // Phase order:
      //   local       → local model only
      //   auto        → local first, then Groq keys, then xAI keys
      //   contingency → Groq keys, then xAI keys, then LOCAL AS LAST RESORT
      //                 (a provider whose credit breaker is open is skipped)
      //   groq/other  → cloud pools only
      const localPhase = { candidates: localCandidates, cursor: () => 0, setCursor: () => {} };
      const cloudPhases = [
        { candidates: groqCandidates, cursor: () => groqKeyCursor, setCursor: (i) => { groqKeyCursor = i; }, providerKey: "groq" },
        { candidates: xaiCandidates, cursor: () => xaiKeyCursor, setCursor: (i) => { xaiKeyCursor = i; }, providerKey: "xai" }
      ];

      let phases;
      if (provider === "local") {
        phases = [localPhase];
      } else if (provider === "auto") {
        phases = [localPhase, ...cloudPhases];
      } else if (provider === "contingency") {
        phases = [...cloudPhases, localPhase];
      } else {
        phases = cloudPhases;
      }

      // Nothing left to try: contingency is configured but no local model is
      // installed and every cloud provider is out of credit. Say so plainly
      // instead of failing with a generic upstream error.
      if (provider === "contingency" && !localCandidates.length
          && CLOUD_PROVIDERS.every(p => cloudBreakerOpen(p))) {
        return sendJson(503, {
          error: {
            message: "Cloud AI credit is exhausted and no local contingency model is available. " +
              "Start a local model and set LOCAL_MODEL (see LOCAL_AI_CONTINGENCY.md)."
          }
        });
      }

      for (const phase of phases) {
        const list = phase.candidates;
        if (!list.length) continue;
        // Skip a cloud provider whose credit breaker is open — including one
        // that tripped earlier in this very request.
        if (phase.providerKey && cloudBreakerOpen(phase.providerKey)) {
          console.warn(`[proxy] skipping ${phase.providerKey} (credit breaker open); next phase`);
          continue;
        }
        const start = phase.cursor() % list.length;
        for (let i = 0; i < list.length; i++) {
          const idx = (start + i) % list.length;
          const cand = list[idx];
          try {
            upRes = await fetch(cand.url, {
              method: "POST",
              headers: cand.headers,
              body: cand.body,
              signal: ctrl.signal
            });
          } catch (e) {
            lastErr = e;
            if (e.name === "AbortError") throw e; // client disconnected / timeout
            console.warn(`[proxy] ${cand.label} candidate ${idx + 1}/${list.length} failed: ${e.message}`);
            continue;
          }
          // Provider-level failure → try the next key, then the next phase.
          // For a CLOUD provider any 4xx/5xx counts: the request body is built
          // here, so a 400 means the provider rejected our key/model/parameters
          // rather than the client sending something malformed. Treating those
          // as terminal (as this proxy used to) meant a provider that answers
          // "bad key" with a 400 instead of a 401 would hand the user a raw
          // upstream error and the contingency would never engage.
          // A failed or unreachable LOCAL model is non-terminal in auto and
          // contingency mode too: it just means "move to the next phase".
          const fromLocal = cand.label === "local model";
          const keyIssue = provider !== "local" && !fromLocal && upRes.status >= 400;
          const localSkippable = fromLocal && (provider === "auto" || provider === "contingency");
          if (!upRes.ok && (keyIssue || localSkippable)) {
            const errText = await upRes.text().catch(() => ""); // drain so the connection can be reused
            if (keyIssue) {
              // Out of credit rather than merely throttled → trip this
              // provider's breaker and abandon its remaining keys. The outer
              // loop then skips the rest of the cloud phases and lands on the
              // local contingency model.
              if (noteCloudCreditFailure(phase.providerKey, upRes.status, errText)) {
                upRes = null;
                break;
              }
              lastKeyErr = { status: upRes.status, text: errText.slice(0, 500) };
              console.warn(`[proxy] ${cand.label} key ${idx + 1}/${list.length} returned ${upRes.status}; trying next key`);
            } else {
              lastErr = new Error(`${cand.label} returned ${upRes.status}`);
              console.warn(`[proxy] ${cand.label} returned ${upRes.status}; falling back to next provider`);
            }
            upRes = null;
            continue;
          }
          allKeyIssues = false;
          if (upRes.ok) {
            phase.setCursor(idx); // remember the key that worked
            chosenCand = cand;
          }
          break; // success, or a non-key error to relay as-is
        }
        // Move to the next provider only if this phase was fully exhausted
        // (every key rate-limited/rejected or unreachable).
        if (upRes) break;
      }
      // Every key was rejected / rate-limited — advance both cursors so the
      // next request starts from a different key, then relay the last error.
      if (!upRes && allKeyIssues) {
        if (groqCandidates.length > 1) groqKeyCursor = (groqKeyCursor + 1) % groqCandidates.length;
        if (xaiCandidates.length > 1) xaiKeyCursor = (xaiKeyCursor + 1) % xaiCandidates.length;
      }
      if (!upRes && lastKeyErr) {
        res.writeHead(lastKeyErr.status, { "Content-Type": "application/json" });
        return res.end(lastKeyErr.text || JSON.stringify({ error: { message: "All API keys failed (last: " + lastKeyErr.status + ")" } }));
      }
      if (!upRes) throw lastErr || new Error("No upstream candidates");

      // Audit: which provider/model answered this chat (5.3). Best-effort.
      writeAudit(chatUser, "chat", {
        detail: provider,
        provider: chosenCand ? chosenCand.label : null,
        model: chosenCand ? chosenCand.model : null
      });

      if (wantsStream && upRes.body) {
        res.writeHead(upRes.status, {
          "Content-Type": upRes.headers.get("content-type") || "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        for await (const chunk of upRes.body) res.write(chunk);
        return res.end();
      }

      const data = await upRes.json();
      res.writeHead(upRes.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (err) {
      if (res.writableEnded) return;
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Upstream request failed: " + (err.message || "unknown") } }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
