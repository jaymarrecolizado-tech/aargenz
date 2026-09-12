// Static files. Serves the Vite build output from dist/ when it exists, falling
// back to the project root (for config.js and other root assets).
//


import fs from "node:fs";
import path from "node:path";
import { MIME } from "../config.js";

export async function handleStatic(ctx) {
  const { req, res, url, sendJson, getSessionUser, requireAdmin, readBodyJson, writeAudit, rootDir: __dirname } = ctx;

  // Static files. Serves the Vite build output from dist/ when it exists,
  // falling back to the project root (for config.js and other root assets).
  const staticRoot = path.join(__dirname, "dist");
  let filePath = path.join(
    fs.existsSync(staticRoot) ? staticRoot : __dirname,
    url.pathname === "/" ? "index.html" : url.pathname
  );
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err && fs.existsSync(staticRoot)) {
      // Retry from the project root before giving up.
      const rootPath = path.join(__dirname, url.pathname);
      if (rootPath.startsWith(__dirname) && fs.existsSync(rootPath)) {
        return fs.readFile(rootPath, (err2, data2) => {
          if (err2) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("Not found");
          }
          res.writeHead(200, { "Content-Type": MIME[path.extname(rootPath).toLowerCase()] || "application/octet-stream" });
          res.end(data2);
        });
      }
      // SPA fallback: serve the built index.html for client-side routes.
      const indexPath = path.join(staticRoot, "index.html");
      if (!url.pathname.startsWith("/api") && fs.existsSync(indexPath)) {
        return fs.readFile(indexPath, (err3, data3) => {
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(data3);
        });
      }
    }
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}
