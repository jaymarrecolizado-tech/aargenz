// Bounded request body readers (P0).
// Memory is capped: once the limit is passed the reader keeps draining the socket
// so the connection stays healthy, but stops buffering and returns null.


import { MAX_BODY_BYTES } from "../config.js";

export const readBodyRaw = async (req, maxBytes = MAX_BODY_BYTES) => {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > maxBytes) return null;
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue; // keep draining, stop buffering
    size += chunk.length;
    if (size > maxBytes) { overflow = true; chunks.length = 0; continue; }
    chunks.push(chunk);
  }
  if (overflow) {
    console.warn(`[server] request body exceeded ${Math.round(maxBytes / 1048576)} MB; discarded`);
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const readBodyJson = async (req, maxBytes = MAX_BODY_BYTES) => {
  const raw = await readBodyRaw(req, maxBytes);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
