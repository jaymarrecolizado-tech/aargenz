import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// "My Reports" list (Phase 3.3): open, duplicate, or delete saved drafts.
export default function MyReports({ user, onOpen }) {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  const load = () => {
    api.listReports(user.role === "admin")
      .then(setReports)
      .catch(e => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  // Phase 6: download the reports list as a CSV for office monitoring.
  // Admins export everyone's reports; encoders their own.
  const exportCsv = async () => {
    setExporting(true);
    setError("");
    try {
      const blob = await api.exportReportsCsv(user.role === "admin");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aar-reports-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      api.auditEvent("export.csv");
    } catch (e) {
      setError(e.message);
    }
    setExporting(false);
  };

  const open = async (r) => {
    try {
      const full = await api.getReport(r.id);
      onOpen(full);
    } catch (e) {
      setError(e.message);
    }
  };

  const duplicate = async (r) => {
    try {
      // Photos are no longer part of the report payload (plan 2.6), so fetch
      // them alongside it or the copy would silently lose its documentation.
      const [full, photoRes] = await Promise.all([
        api.getReport(r.id),
        api.getPhotos(r.id).catch(() => ({ photos: [] }))
      ]);
      const photos = (photoRes?.photos || [])
        .map(p => (typeof p === "string" ? p : p.dataUrl))
        .filter(Boolean);
      await api.createReport({
        templateId: full.template_id,
        title: full.title ? full.title + " (copy)" : "Copy of report",
        status: "draft",
        conversation: full.conversation,
        report: full.report,
        photos
      });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.title || "Untitled report"}"? This cannot be undone.`)) return;
    try {
      await api.deleteReport(r.id);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div style={{width:"100%", maxWidth:"850px"}}>
      <div className="panel" style={{padding:"24px"}}>
        <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"4px", flexWrap:"wrap"}}>
          <div style={{fontSize:"17px", fontWeight:"700", color:"var(--text)", flex:"1 1 auto"}}>
            {user.role === "admin" ? "All Reports" : "My Reports"}
          </div>
          <button onClick={exportCsv} disabled={exporting} title="Download this list as a CSV spreadsheet (Excel-ready)" className="mini-btn primary" style={{opacity: exporting ? 0.6 : 1, cursor: exporting ? "wait" : "pointer"}}>
            {exporting ? "Preparing…" : "Export CSV"}
          </button>
        </div>
        <div style={{fontSize:"12px", color:"var(--muted)", marginBottom:"16px"}}>Saved drafts sync automatically as you work. Open one to continue where you left off.</div>

        {error && <div className="err-box">{error}</div>}
        {reports === null && !error && <div style={{color:"var(--muted)", fontSize:"13px"}}>Loading…</div>}

        {reports?.length === 0 && (
          <div style={{color:"var(--muted)", fontSize:"13px", padding:"24px 0"}}>
            No saved reports yet — start a chat and it will be saved automatically.
          </div>
        )}

        {(reports || []).map(r => (
          <div key={r.id} style={{
            display:"flex", alignItems:"center", gap:"12px", padding:"10px 12px",
            borderBottom:"1px solid var(--border)"
          }}>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontWeight:"600", fontSize:"14px", color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                {r.title || "Untitled report"}
                {r.owner_name && r.owner_name !== user.username && (
                  <span style={{marginLeft:"8px", fontSize:"11px", color:"var(--accent)"}}>by {r.owner_name}</span>
                )}
              </div>
              <div style={{fontSize:"11px", color:"var(--muted)"}}>
                {r.control_no && (
                  <span style={{color:"var(--accent)", fontWeight:"600"}}>{r.control_no} · </span>
                )}
                {r.template_id} · {new Date(r.updated_at).toLocaleString()} · {r.status}
                {r.photos_count ? ` · ${r.photos_count} photo${r.photos_count === 1 ? "" : "s"}` : ""}
              </div>
            </div>
            <button onClick={() => open(r)} className="mini-btn primary">Open</button>
            <button onClick={() => duplicate(r)} className="mini-btn">Duplicate</button>
            <button onClick={() => remove(r)} className="mini-btn danger">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
