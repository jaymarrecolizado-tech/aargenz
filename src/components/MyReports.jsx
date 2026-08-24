import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// "My Reports" list (Phase 3.3): open, duplicate, or delete saved drafts.
export default function MyReports({ user, onOpen }) {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");

  const load = () => {
    api.listReports(user.role === "admin")
      .then(setReports)
      .catch(e => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

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
      const full = await api.getReport(r.id);
      await api.createReport({
        templateId: full.template_id,
        title: full.title ? full.title + " (copy)" : "Copy of report",
        status: "draft",
        conversation: full.conversation,
        report: full.report,
        photos: full.photos
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
      <div style={{background:"#fff", borderRadius:"12px", boxShadow:"0 4px 24px rgba(0,0,100,0.15)", padding:"24px"}}>
        <div style={{fontSize:"18px", fontWeight:"700", color:"#0011aa", marginBottom:"4px"}}>
          {user.role === "admin" ? "All Reports" : "My Reports"}
        </div>
        <div style={{fontSize:"12px", color:"#666", marginBottom:"16px"}}>Saved drafts sync automatically as you work. Open one to continue where you left off.</div>

        {error && <div style={errBox}>{error}</div>}
        {reports === null && !error && <div style={{color:"#666", fontSize:"13px"}}>Loading…</div>}

        {reports?.length === 0 && (
          <div style={{color:"#888", fontSize:"13px", padding:"24px 0"}}>
            No saved reports yet — start a chat and it will be saved automatically.
          </div>
        )}

        {(reports || []).map(r => (
          <div key={r.id} style={{
            display:"flex", alignItems:"center", gap:"12px", padding:"10px 12px",
            borderBottom:"1px solid #eef1fa"
          }}>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontWeight:"600", fontSize:"14px", color:"#222", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                {r.title || "Untitled report"}
                {r.owner_name && r.owner_name !== user.username && (
                  <span style={{marginLeft:"8px", fontSize:"11px", color:"#0033cc"}}>by {r.owner_name}</span>
                )}
              </div>
              <div style={{fontSize:"11px", color:"#888"}}>
                {r.template_id} · {new Date(r.updated_at).toLocaleString()} · {r.status}
              </div>
            </div>
            <button onClick={() => open(r)} style={btn("#0033cc")}>Open</button>
            <button onClick={() => duplicate(r)} style={btn("rgba(255,255,255,0.15)", true)}>Duplicate</button>
            <button onClick={() => remove(r)} style={btn("#c62828")}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

const errBox = { background:"#fdecea", color:"#b71c1c", borderRadius:"8px", padding:"8px 12px", fontSize:"12px", marginBottom:"12px" };
const btn = (bg, ghost) => ({
  padding:"6px 14px", borderRadius:"20px", border:"none", cursor:"pointer",
  fontSize:"12px", fontWeight:"600", background:bg, color: ghost ? "#555" : "#fff"
});
