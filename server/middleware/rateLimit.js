// Rate limiting.
// Two different shapes on purpose: a token bucket for /api/chat (burst-tolerant),
// and fixed windows for credential attempts, tracked per username AND per IP
// because a whole regional office shares one NAT address.


// key pool from runaway usage. CHAT_RATE_MAX = burst size,
// CHAT_RATE_REFILL_MS = ms between refunded tokens.
export const CHAT_RATE_MAX = Number(process.env.CHAT_RATE_MAX || 30);
export const CHAT_RATE_REFILL_MS = Number(process.env.CHAT_RATE_REFILL_MS || 2000);
export const chatBuckets = new Map();
setInterval(() => { // drop stale buckets so the map doesn't grow forever
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of chatBuckets) if (b.last < cutoff) chatBuckets.delete(k);
}, 60 * 1000).unref();

// ---- Auth throttling (P0) --------------------------------------------------
// /api/chat was rate-limited but the login endpoint was not, which made it the
// softest target on a public HTTPS host. Fixed-window counters keyed on both
// the client IP and the attempted username, so neither a single account nor a
// single source can be hammered. A successful login clears both.
//
// The two limits are deliberately different. A whole regional office sits
// behind one NAT address, so a tight per-IP limit would let one person's typos
// lock out every colleague for the whole window. The per-username limit is
// therefore tight (protects the account) and the per-IP limit is loose
// (protects the service).
export const AUTH_RATE_MAX = Number(process.env.AUTH_RATE_MAX || 10);          // per username
export const AUTH_RATE_MAX_IP = Number(process.env.AUTH_RATE_MAX_IP || 60);    // per IP
export const AUTH_RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000);
export const authBuckets = new Map();

export function authBucket(key) {
  const now = Date.now();
  let b = authBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS };
    authBuckets.set(key, b);
  }
  return b;
}
export const authLimitFor = (key) => (key.startsWith("ip:") ? AUTH_RATE_MAX_IP : AUTH_RATE_MAX);
export const authBlocked = (key) => authBucket(key).count >= authLimitFor(key);
export const authPenalize = (key) => { authBucket(key).count++; };
export const authForgive = (key) => { authBuckets.delete(key); };

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of authBuckets) if (now >= b.resetAt) authBuckets.delete(k);
}, 5 * 60 * 1000).unref();

export function allowChat(key) {
  const now = Date.now();
  let bucket = chatBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: CHAT_RATE_MAX, last: now };
    chatBuckets.set(key, bucket);
  }
  bucket.tokens = Math.min(CHAT_RATE_MAX, bucket.tokens + Math.floor((now - bucket.last) / CHAT_RATE_REFILL_MS));
  bucket.last = now;
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

// Index of the last key that worked; new requests start from it so a healthy
