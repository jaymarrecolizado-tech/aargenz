// Server API helpers (auth + saved reports). Cookies carry the session, so
// no token handling is needed here — the browser does it automatically.

async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    if (data?.error?.details) err.details = data.error.details;
    throw err;
  }
  return data;
}

export const api = {
  me: () => req("api/auth/me"),
  register: (username, password) => req("api/auth/register", { method: "POST", body: { username, password } }),
  login: (username, password) => req("api/auth/login", { method: "POST", body: { username, password } }),
  logout: () => req("api/auth/logout", { method: "POST" }),

  listReports: (all) => req(`api/reports${all ? "?all=1" : ""}`),
  getReport: (id) => req(`api/reports/${id}`),
  createReport: (payload) => req("api/reports", { method: "POST", body: payload }),
  updateReport: (id, patch) => req(`api/reports/${id}`, { method: "PUT", body: patch }),
  deleteReport: (id) => req(`api/reports/${id}`, { method: "DELETE" }),

  getPersonnel: (templateId) => req(`api/templates/${templateId}/personnel`),
  savePersonnel: (templateId, personnel) =>
    req(`api/templates/${templateId}/personnel`, { method: "PUT", body: personnel }),

  getTemplateConfig: (templateId) => req(`api/templates/${templateId}`),
  saveTemplate: (config) => req(`api/templates/${config.id}`, { method: "PUT", body: config }),

  // Default header/footer logos per template (Phase 8.4): stored server-side
  // under templates/<id>/ and referenced from template.json.
  uploadTemplateLogo: (templateId, kind, dataUrl) =>
    req(`api/templates/${templateId}/logo`, { method: "POST", body: { kind, dataUrl } }),
  deleteTemplateLogo: (templateId, kind) =>
    req(`api/templates/${templateId}/logo?kind=${kind}`, { method: "DELETE" }),

  // Audit trail (Phase 5.3): record a client-side event (fire-and-forget —
  // an export must never fail because logging did) and read the log (admin).
  auditEvent: (action, detail) => {
    req("api/audit", { method: "POST", body: { action, detail } }).catch(() => {});
  },
  getAuditLog: (limit = 200) => req(`api/audit?limit=${limit}`)
};
