// AI provider status (admin). Answers the contingency question directly:
// which providers are configured, is the local fallback actually reachable right
// now, and has the credit breaker tripped? See LOCAL_AI_CONTINGENCY.md.
//


import path from "node:path";
import { AI_PROVIDER, GROQ_KEYS, GROQ_MODEL, XAI_KEYS, XAI_MODEL, LOCAL_BASE_URL, LOCAL_MODEL } from "../config.js";
import { cloudBreakerOpen, cloudBreakerState } from "../lib/contingency.js";

export async function handleAiStatus(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  // AI provider status (admin). Answers the contingency question directly:
  // which providers are configured, is the local fallback actually reachable
  // right now, and has the credit breaker tripped? See LOCAL_AI_CONTINGENCY.md.
  if (url.pathname === "/api/ai/status") {
    if (req.method !== "GET") return sendJson(405, { error: { message: "Method not allowed" } });
    const admin = await requireAdmin();
    if (!admin) return;

    // Short probe — an unreachable local server must not hang the admin panel.
    const local = {
      configured: !!LOCAL_MODEL, model: LOCAL_MODEL, baseUrl: LOCAL_BASE_URL,
      reachable: false, modelPresent: null, models: [], error: null
    };
    try {
      const probe = await fetch(`${LOCAL_BASE_URL}/models`, { signal: AbortSignal.timeout(2500) });
      if (probe.ok) {
        const data = await probe.json().catch(() => null);
        local.reachable = true;
        local.models = Array.isArray(data?.data)
          ? data.data.map(m => m.id).filter(Boolean).slice(0, 50)
          : [];
        local.modelPresent = local.models.length ? local.models.includes(LOCAL_MODEL) : null;
      } else {
        local.error = `HTTP ${probe.status}`;
      }
    } catch (e) {
      local.error = (e.name === "TimeoutError" || e.name === "AbortError")
        ? "timed out after 2.5s"
        : (e.message || "unreachable");
    }

    // The fallback order the server would actually attempt right now, with
    // providers that are out of credit omitted.
    const chain = [];
    const pushCloud = () => {
      if (GROQ_KEYS.length && !cloudBreakerOpen("groq")) chain.push(`groq:${GROQ_MODEL}`);
      if (XAI_KEYS.length && !cloudBreakerOpen("xai")) chain.push(`xai:${XAI_MODEL}`);
    };
    const pushLocal = () => { if (LOCAL_MODEL) chain.push(`local:${LOCAL_MODEL}`); };
    if (AI_PROVIDER === "local") pushLocal();
    else if (AI_PROVIDER === "auto") { pushLocal(); pushCloud(); }
    else if (AI_PROVIDER === "contingency") { pushCloud(); pushLocal(); }
    else pushCloud();

    return sendJson(200, {
      providerMode: AI_PROVIDER,
      modes: ["contingency", "auto", "local", "groq"],
      cloud: {
        groq: { keys: GROQ_KEYS.length, model: GROQ_MODEL },
        xai: { keys: XAI_KEYS.length, model: XAI_MODEL }
      },
      local,
      breaker: cloudBreakerState(),
      effectiveChain: chain,
      // True when the offline path is genuinely usable, not merely configured.
      contingencyReady: !!(LOCAL_MODEL && local.reachable)
    });
  }
}
