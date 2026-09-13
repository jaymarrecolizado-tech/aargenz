// Report lifecycle (plan 3.1): draft → submitted → approved | rejected, plus
// the two escape hatches (withdraw, reopen).
//
// This file is the single source of truth for the lifecycle. The route uses it
// to authorise a transition, and PUT uses it to decide whether a row may be
// edited at all — so the lock on an approved report is enforced in one place
// instead of being re-derived from `status` at each call site.
//

export const STATUSES = ["draft", "submitted", "approved", "rejected"];

// `actor` is who may perform the action. "owner" actions are also allowed for
// an admin (an admin can submit or withdraw on someone's behalf); "admin"
// actions are reviewers only.
export const TRANSITIONS = {
  submit: {
    from: ["draft", "rejected"], to: "submitted", actor: "owner",
    label: "Submitted for review", past: "submitted"
  },
  withdraw: {
    from: ["submitted"], to: "draft", actor: "owner",
    label: "Withdrawn from review", past: "withdrawn"
  },
  approve: {
    from: ["submitted"], to: "approved", actor: "admin",
    label: "Approved", past: "approved"
  },
  reject: {
    from: ["submitted"], to: "rejected", actor: "admin",
    label: "Rejected", past: "rejected",
    // A rejection with no reason is useless to the encoder, so it is required.
    requiresRemarks: true
  },
  reopen: {
    from: ["approved"], to: "draft", actor: "admin",
    label: "Reopened after approval", past: "reopened"
  }
};

// Statuses in which the owner may still change the report body. Once submitted
// the body is frozen for the owner — otherwise a reviewer could approve
// something that changed underneath them. The owner withdraws it to edit.
const OWNER_EDITABLE = new Set(["draft", "rejected"]);

// `approved` is the immutability guarantee: nobody edits it in place, including
// an admin, who must reopen it first so the change leaves an audit trail.
const ADMIN_EDITABLE = new Set(["draft", "submitted", "rejected"]);

export const isEditable = (status, role) =>
  (role === "admin" ? ADMIN_EDITABLE : OWNER_EDITABLE).has(status);

// True when the row is frozen for this particular user, which is what PUT
// needs: an admin may edit a submitted report that its owner may not.
export const isLockedFor = (status, user, isOwner) =>
  user?.role === "admin" ? !ADMIN_EDITABLE.has(status) : !(isOwner && OWNER_EDITABLE.has(status));

// Returns { ok: true, transition } or { ok: false, message } — the message is
// shown to the user, so it says what is wrong rather than "forbidden".
export function canTransition(status, action, { role, isOwner }) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, message: `Unknown action "${action}"` };
  if (!t.from.includes(status)) {
    return { ok: false, message: `This report is ${status}; it cannot be ${t.past}.` };
  }
  if (t.actor === "admin" && role !== "admin") {
    return { ok: false, message: "Only a reviewer can approve or reject a report." };
  }
  if (t.actor === "owner" && !isOwner && role !== "admin") {
    return { ok: false, message: "Only the report's owner can submit or withdraw it." };
  }
  return { ok: true, transition: t };
}

// The columns a transition writes. `NOW()` is inlined rather than bound so the
// timestamp comes from the database, not the app server's clock. Returns null
// for an unknown action.
export function buildStamp(action, user, remarks) {
  const cleared = [
    "submitted_by = NULL", "submitted_by_name = NULL", "submitted_at = NULL",
    "reviewed_by = NULL", "reviewed_by_name = NULL", "reviewed_at = NULL",
    "remarks = NULL"
  ];
  const reviewed = (note) => ({
    sets: ["reviewed_by = ?", "reviewed_by_name = ?", "reviewed_at = NOW()", "remarks = ?"],
    params: [user.id, user.username, note ?? null]
  });

  switch (action) {
    case "submit":
      // Re-submitting after a rejection clears the previous verdict, so the
      // reviewer sees a clean request rather than the old remarks.
      return {
        sets: ["submitted_by = ?", "submitted_by_name = ?", "submitted_at = NOW()", ...cleared.slice(3)],
        params: [user.id, user.username]
      };
    case "withdraw":
      return { sets: cleared, params: [] };
    case "approve":
      return reviewed(remarks);
    case "reject":
      return reviewed(remarks);
    case "reopen":
      // Keep submitted_*: it records when the report entered review, and the
      // next submit overwrites it anyway.
      return { sets: cleared.slice(3), params: [] };
    default:
      return null;
  }
}
