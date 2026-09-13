// Client-side lifecycle helpers (plan 3.1). These re-export the exact rule
// set the server enforces in server/lib/review.js so the two can never drift
// apart — the server is the real authority, but the UI needs the same
// transition/lock logic to decide which buttons to show and whether the preview
// is editable.
//
// review.js is pure logic (no Node-only imports), so Vite bundles it for the
// browser unchanged.
export {
  STATUSES,
  TRANSITIONS,
  isEditable,
  isLockedFor,
  canTransition
} from "../../server/lib/review.js";
