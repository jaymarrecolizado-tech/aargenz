import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// Reviewer queue (plan 3.1): admins see every report currently "submitted" and
// can approve or reject it in place. Rejection requires a reason, which the
// encoder sees when they reopen the report.
export default function ReviewQueue() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null); // id currently being actioned

  const load = () => {
    setError("");
    api.listReports(true, "submitted")
      .then(setItems)
      .catch(e => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const decide = async (r, action, remarks) => {
    setBusy(r.id + ":" + action);
    setError("");
    try {
      await api.transitionReport(r.id, action, remarks);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const reject = (r) => {
    const rm = window.prompt(`Reason for rejecting "${r.title || "this report"}" (required):`);
    if (rm == null) return;
    if (!rm.trim()) { window.alert("A reason is required to reject a report."); return; }
    decide(r, "reject", rm.trim());
  };

  const fmt = (ts) => {
    try { return new Date(ts).toLocaleString(); } catch { return ts || ""; }
  };

  return (
    <div>
      <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"10px"}}>
        <div style={{fontSize:"13px", fontWeight:"600", color:"var(--text)"}}>Reports awaiting review</div>
        <button onClick={load} className="mini-btn" style={{marginLeft:"auto"}} disabled={!items}>↻ Refresh</button>
      </div>
      {error && <div style={{background:"#fdecea", color:"#b71c1c", borderRadius:"8px", padding:"8px 12px", fontSize:"12px", marginBottom:"12px"}}>{error}</div>}
      {!items && !error && <div style={{color:"var(--muted)", fontSize:"13px"}}>Loading…</div>}
      {items && (
        items.length === 0 ? (
          <div style={{color:"var(--muted)", fontSize:"13px", padding:"20px 0", fontStyle:"italic"}}>Nothing in the queue — every submitted report has been reviewed.</div>
        ) : (
          <div style={{border:"1px solid var(--border)", borderRadius:"10px", overflow:"hidden"}}>
            {items.map(r => (
              <div key={r.id} style={{display:"flex", alignItems:"center", gap:"12px", padding:"10px 12px", borderBottom:"1px solid var(--border)", flexWrap:"wrap"}}>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontWeight:"600", fontSize:"14px", color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                    {r.title || "Untitled report"}
                    {r.owner_name && <span style={{marginLeft:"8px", fontSize:"11px", color:"var(--accent)"}}>by {r.owner_name}</span>}
                  </div>
                  <div style={{fontSize:"11px", color:"var(--muted)"}}>
                    {r.control_no ? <span style={{color:"var(--accent)", fontWeight:"600"}}>{r.control_no} · </span> : null}
                    {r.template_id} · submitted {fmt(r.submitted_at)}{r.submitted_by_name ? ` by ${r.submitted_by_name}` : ""}
                    {r.photos_count ? ` · ${r.photos_count} photo${r.photos_count === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => decide(r, "approve")}
                  className="mini-btn primary"
                  style={{background:"#15803d", borderColor:"#15803d", color:"#fff"}}
                  disabled={busy != null}
                >Approve</button>
                <button
                  onClick={() => reject(r)}
                  className="mini-btn danger"
                  disabled={busy != null}
                >Reject</button>
              </div>
            ))}
          </div>
        )
      )}
      <div style={{fontSize:"11px", color:"var(--muted)", marginTop:"14px"}}>
        Approving locks the report as the official record. Rejecting sends it back to the encoder with your reason so they can fix and resubmit.
      </div>
    </div>
  );
}
