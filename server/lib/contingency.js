// Cloud credit-exhaustion breaker.
// Distinguishes "out of money" from "throttled", per provider, so a broke Groq
// does not block xAI. See LOCAL_AI_CONTINGENCY.md.


// ---- Contingency: cloud credit-exhaustion circuit breaker ------------------
// When a cloud provider answers with "you are out of credit/quota" rather than
// a per-key rate limit, retrying the next key is pointless. We open a breaker
// for CONTINGENCY_COOLDOWN_MS and route straight to the local model, so a
// regional office keeps producing reports when the token budget runs out.
export const CONTINGENCY_COOLDOWN_MS = Number(process.env.CONTINGENCY_COOLDOWN_MS || 15 * 60 * 1000);
export const CONTINGENCY_ENABLED = !/^(0|false|off)$/i.test(process.env.CONTINGENCY_ENABLED || "1");
// Signals that a key is out of money, not merely throttled. Groq/xAI return 402
// for exhausted credit and 429 with an insufficient_quota-style body when the
// free tier is spent.
export const CREDIT_EXHAUSTED_RE = /insufficient[_ ]?quota|exceeded your current quota|quota exceeded|billing|out of credit|no credit|payment required|credit balance|spending limit|free tier/i;
// Breakers are tracked per provider: Groq running out of credit says nothing
// about xAI's balance, so only the broke provider gets skipped.
export const CLOUD_PROVIDERS = ["groq", "xai"];
export const cloudBreakerUntil = { groq: 0, xai: 0 };   // epoch ms; > now = skip this provider
export const cloudBreakerReason = { groq: null, xai: null };
export let cloudBreakerTrips = 0;

export const cloudBreakerOpen = (providerKey) =>
  CONTINGENCY_ENABLED && !!providerKey && Date.now() < (cloudBreakerUntil[providerKey] || 0);

export function noteCloudCreditFailure(providerKey, status, text) {
  if (!CONTINGENCY_ENABLED || !providerKey) return false;
  if (status !== 402 && !(status === 429 && CREDIT_EXHAUSTED_RE.test(text || ""))) return false;
  cloudBreakerUntil[providerKey] = Date.now() + CONTINGENCY_COOLDOWN_MS;
  cloudBreakerReason[providerKey] = status === 402 ? "payment required (402)" : "quota/credit exhausted (429)";
  cloudBreakerTrips++;
  console.warn(
    `[proxy] ${providerKey} credit exhausted — ${cloudBreakerReason[providerKey]}. ` +
    `Skipping it for ${Math.round(CONTINGENCY_COOLDOWN_MS / 60000)} min; ` +
    `falling through to the local contingency model (${LOCAL_MODEL}).`
  );
  return true;
}

export const cloudBreakerState = () => ({
  enabled: CONTINGENCY_ENABLED,
  cooldownSeconds: Math.round(CONTINGENCY_COOLDOWN_MS / 1000),
  trips: cloudBreakerTrips,
  providers: Object.fromEntries(CLOUD_PROVIDERS.map(p => [
    p,
    {
      open: cloudBreakerOpen(p),
      reason: cloudBreakerReason[p],
      resumesInSeconds: cloudBreakerOpen(p)
        ? Math.round((cloudBreakerUntil[p] - Date.now()) / 1000)
        : 0
    }
  ]))
});
