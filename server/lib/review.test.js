import { describe, it, expect } from "vitest";
import {
  STATUSES, TRANSITIONS, isEditable, isLockedFor, canTransition, buildStamp
} from "./review.js";

const owner = { id: "u-owner", username: "encoder1", role: "encoder" };
const admin = { id: "u-admin", username: "reviewer1", role: "admin" };
const asOwner = { role: "encoder", isOwner: true };
const asOtherEncoder = { role: "encoder", isOwner: false };
const asAdmin = { role: "admin", isOwner: false };

describe("lifecycle shape", () => {
  it("every transition target is a real status", () => {
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      expect(STATUSES, action).toContain(t.to);
      for (const from of t.from) expect(STATUSES, action).toContain(from);
    }
  });

  it("covers the documented path draft -> submitted -> approved | rejected", () => {
    expect(canTransition("draft", "submit", asOwner).ok).toBe(true);
    expect(canTransition("submitted", "approve", asAdmin).ok).toBe(true);
    expect(canTransition("submitted", "reject", asAdmin).ok).toBe(true);
  });
});

describe("canTransition", () => {
  it("rejects an unknown action", () => {
    expect(canTransition("draft", "publish", asOwner).ok).toBe(false);
  });

  it("only allows submit from draft or rejected", () => {
    expect(canTransition("draft", "submit", asOwner).ok).toBe(true);
    expect(canTransition("rejected", "submit", asOwner).ok).toBe(true);
    expect(canTransition("submitted", "submit", asOwner).ok).toBe(false);
    expect(canTransition("approved", "submit", asOwner).ok).toBe(false);
  });

  it("only allows approve/reject from submitted", () => {
    expect(canTransition("draft", "approve", asAdmin).ok).toBe(false);
    expect(canTransition("approved", "approve", asAdmin).ok).toBe(false);
    expect(canTransition("rejected", "reject", asAdmin).ok).toBe(false);
    expect(canTransition("submitted", "approve", asAdmin).ok).toBe(true);
  });

  it("only allows reopen from approved", () => {
    expect(canTransition("approved", "reopen", asAdmin).ok).toBe(true);
    expect(canTransition("submitted", "reopen", asAdmin).ok).toBe(false);
    expect(canTransition("draft", "reopen", asAdmin).ok).toBe(false);
  });

  it("reserves approve/reject/reopen for reviewers", () => {
    expect(canTransition("submitted", "approve", asOwner).ok).toBe(false);
    expect(canTransition("submitted", "reject", asOwner).ok).toBe(false);
    expect(canTransition("approved", "reopen", asOwner).ok).toBe(false);
    // ...but an admin may act on someone else's report.
    expect(canTransition("submitted", "approve", asAdmin).ok).toBe(true);
  });

  it("reserves submit/withdraw for the owner", () => {
    expect(canTransition("draft", "submit", asOtherEncoder).ok).toBe(false);
    expect(canTransition("submitted", "withdraw", asOtherEncoder).ok).toBe(false);
    // An admin can do it on the owner's behalf.
    expect(canTransition("draft", "submit", asAdmin).ok).toBe(true);
  });

  it("explains itself without a broken article", () => {
    const r = canTransition("approved", "submit", asOwner);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("This report is approved; it cannot be submitted.");
    expect(r.message).not.toMatch(/\ba (a|e|i|o|u)/i);
  });

  it("requires remarks for a rejection", () => {
    expect(TRANSITIONS.reject.requiresRemarks).toBe(true);
    expect(TRANSITIONS.approve.requiresRemarks).toBeUndefined();
  });
});

describe("edit lock", () => {
  it("lets an owner edit only draft and rejected", () => {
    expect(isEditable("draft", "encoder")).toBe(true);
    expect(isEditable("rejected", "encoder")).toBe(true);
    expect(isEditable("submitted", "encoder")).toBe(false);
    expect(isEditable("approved", "encoder")).toBe(false);
  });

  it("lets an admin edit submitted too, but never approved", () => {
    expect(isEditable("draft", "admin")).toBe(true);
    expect(isEditable("submitted", "admin")).toBe(true);
    expect(isEditable("rejected", "admin")).toBe(true);
    expect(isEditable("approved", "admin")).toBe(false);
  });

  it("locks an approved report for everyone", () => {
    expect(isLockedFor("approved", admin, false)).toBe(true);
    expect(isLockedFor("approved", owner, true)).toBe(true);
  });

  it("distinguishes the owner from another encoder on a submitted report", () => {
    expect(isLockedFor("submitted", owner, true)).toBe(true);
    expect(isLockedFor("submitted", admin, false)).toBe(false);
  });

  it("does not lock a draft for its owner", () => {
    expect(isLockedFor("draft", owner, true)).toBe(false);
  });
});

describe("buildStamp", () => {
  it("stamps the submitter on submit and clears any previous verdict", () => {
    const { sets, params } = buildStamp("submit", owner, null);
    expect(params).toEqual(["u-owner", "encoder1"]);
    expect(sets.join(" ")).toContain("submitted_by = ?");
    expect(sets.join(" ")).toContain("submitted_at = NOW()");
    expect(sets.join(" ")).toContain("reviewed_by = NULL");
    expect(sets.join(" ")).toContain("remarks = NULL");
    expect(params).toHaveLength(sets.filter(s => s.includes("?")).length);
  });

  it("stamps the reviewer on approve and keeps an optional note", () => {
    const { sets, params } = buildStamp("approve", admin, "Looks good");
    expect(params).toEqual(["u-admin", "reviewer1", "Looks good"]);
    expect(sets.join(" ")).toContain("reviewed_at = NOW()");
  });

  it("stores a null note when approve has no remarks", () => {
    expect(buildStamp("approve", admin, undefined).params[2]).toBe(null);
  });

  it("clears the verdict on withdraw", () => {
    const { sets, params } = buildStamp("withdraw", owner, null);
    expect(params).toEqual([]);
    expect(sets.join(" ")).toContain("submitted_at = NULL");
    expect(sets.join(" ")).toContain("reviewed_at = NULL");
  });

  it("keeps the submission record on reopen", () => {
    const { sets } = buildStamp("reopen", admin, null);
    const joined = sets.join(" ");
    expect(joined).toContain("reviewed_at = NULL");
    expect(joined).not.toContain("submitted_at");
  });

  it("returns null for an unknown action", () => {
    expect(buildStamp("publish", admin, null)).toBe(null);
  });

  it("never leaves a placeholder without a matching parameter", () => {
    for (const action of Object.keys(TRANSITIONS)) {
      const { sets, params } = buildStamp(action, admin, "note");
      expect(params.length, action).toBe(sets.filter(s => s.includes("?")).length);
    }
  });
});
