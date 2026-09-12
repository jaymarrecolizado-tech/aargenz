// Static files. Serves the Vite build output from dist/ when it exists, falling
// back to the project root for the few assets the built app fetches at runtime.
//

import fs from "node:fs";
import path from "node:path";
import { MIME } from "../config.js";

// The project root is NOT a document root. Only these paths may be served from
// it, because they are the only root files the built app actually requests:
//   - config.js    <- <script src="./config.js"> in index.html
//   - index.html   <- document root when there is no build yet
//   - templates/** <- logos referenced by template.json's headerLogo/footerLogo
// Everything else in the root is source or configuration — server.js, db.js,
// package.json, *.md, *.sql, .env, server/**, pics/** — and must never be
// reachable over HTTP. Before this allowlist existed the fallback served *any*
// existing root file, so GET /server.js, GET /db.js and GET /package.json all
// returned source.
const ROOT_FILES = new Set(["/config.js", "/index.html"]);
const ROOT_PREFIXES = ["/templates/"];

const mayServeFromRoot = (relPath) =>
  ROOT_FILES.has(relPath) || ROOT_PREFIXES.some((prefix) => relPath.startsWith(prefix));

const mimeFor = (filePath) =>
  MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";

export async function handleStatic(ctx) {
  const { res, url, rootDir: __dirname } = ctx;

  const distDir = path.join(__dirname, "dist");
  const hasBuild = fs.existsSync(distDir);
  const relPath = url.pathname === "/" ? "/index.html" : url.pathname;

  // Candidate files in priority order. The build output wins when it exists;
  // the project root is consulted only for the allowlisted runtime assets.
  const candidates = [];
  if (hasBuild) {
    const inDist = path.join(distDir, relPath);
    if (inDist.startsWith(distDir)) candidates.push(inDist);
  }
  if (mayServeFromRoot(relPath)) {
    const inRoot = path.join(__dirname, relPath);
    if (inRoot.startsWith(__dirname)) candidates.push(inRoot);
  }

  for (const file of candidates) {
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { "Content-Type": mimeFor(file) });
      return res.end(data);
    } catch { /* try the next candidate */ }
  }

  // SPA fallback: unknown non-API paths render the app shell.
  const indexPath = path.join(distDir, "index.html");
  if (!url.pathname.startsWith("/api") && fs.existsSync(indexPath)) {
    const data = await fs.promises.readFile(indexPath);
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(data);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  return res.end("Not found");
}
