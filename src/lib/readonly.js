import { createContext, useContext } from "react";

// Read-only mode for the report preview (plan 3.1).
//
// Once a report is submitted or approved the server refuses further writes, so
// the preview must stop *offering* them — otherwise every click opens an editor
// that silently reverts. The three preview components each define their own
// copy of the click-to-edit primitive, so rather than thread a `readOnly` prop
// through all of them (and every call site), they read it from here.
//
// This is presentation only. The real lock is enforced server-side in
// server/lib/review.js and verified against the API.
export const ReadOnlyContext = createContext(false);

export const useReadOnly = () => useContext(ReadOnlyContext);
