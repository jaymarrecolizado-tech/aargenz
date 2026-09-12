// The one place that knows how to write a JSON response.
//
// Kept separate from the request context so modules that only need to *reply*
// (session guards, for example) don't have to depend on the whole context.

export function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
