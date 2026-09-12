// Optimistic concurrency (plan 2.7).
// reports.version is a monotonic INT rather than updated_at, because updated_at is
// a one-second TIMESTAMP: two saves inside the same second would look identical
// and the check would pass when it should not.


// ---- Optimistic concurrency (plan 2.7) ------------------------------------
// Autosave used to be last-write-wins: two tabs (or a laptop and a desktop)
// silently overwrote each other, and a queued retry could resurrect a payload
// captured up to a minute earlier. Clients now send the version they loaded and
// a mismatch is rejected with 409 so the user chooses which copy to keep.
//
// reports.version is a monotonic INT rather than updated_at, because
// updated_at is a one-second TIMESTAMP: two saves inside the same second would
// look identical and the check would pass when it should not.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses the client's expected version. Returns undefined when the client
// didn't send one (older client, or a path that doesn't track versions) so the
// caller can skip the check instead of rejecting the write.
export function expectedVersion(body) {
  if (!body || body.version == null) return undefined;
  const n = Number(body.version);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}
