import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { canTransition } from "../lib/lifecycle.js";

// Fields that identify *when* an activity took place. A duplicate describes a
// new activity, so these are reset rather than carried over (plan 3.4) — the
// same set the bundled templates use (`dateTime` everywhere, plus a time-of-day
// field in two of them).
const ACTIVITY_TIME_FIELDS = ["dateTime", "time", "timeOfArrival"];

// Lifecycle status badge (plan 3.1). Colour-coded so each report's state reads
// at a glance.
const STATUS_LABELS = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected" };
const STATUS_COLORS = {
  draft:     { bg: "#eef1f6", fg: "#475467" },
  submitted: { bg: "#fef3e2", fg: "#994d00" },
  approved:  { bg: "#e6f4ea", fg: "#137333" },
  rejected:  { bg: "#fdecea", fg: "#b71c1c" }
};
function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.draft;
  return (
    <span style={{
      display: "inline-block", padding: "1px 9px", borderRadius: "10px",
      fontSize: "10px", fontWeight: "700", background: c.bg, color: c.fg,
      textTransform: "uppercase", letterSpacing: "0.4px"
    }}>
      {STATUS_LABELS[status] || status || "Draft"}
    </span>
  );
}

// "My Reports" list (Phase 3.3): open, submit/withdraw/approve/reject/reopen,
// duplicate, or delete saved drafts (plan 3.1 adds the lifecycle actions).
export default function MyReports({ user, onOpen }) {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => {
    setMsg("");
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
      // Photos are deliberately NOT copied (plan 3.4): a duplicate is for a new
      // activity, so the original's documentation would be misleading. Fetching
      // them would also be wasted work, since 2.6 moved them to their own table.
      const full = await api.getReport(r.id);
      const report = { ...(full.report || {}) };
      // Reset the fields that identify *when* the activity happened, otherwise
      // the copy is filed under the original's date (plan 3.4). All four
      // bundled templates use `dateTime`; two add a time-of-day field.
      for (const key of ACTIVITY_TIME_FIELDS) if (key in report) report[key] = "";
      // The control number is re-issued by the server on create (plan 3.2), so
      // whatever the original carried is overwritten — no need to blank it here.
      await api.createReport({
        templateId: full.template_id,
        title: full.title ? full.title + " (copy)" : "Copy of report",
        status: "draft",
        conversation: full.conversation,
        report
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

  // Lifecycle actions (plan 3.1). Each calls the single transition endpoint,
  // which enforces the state machine; we only show the buttons the server would
  // allow for this user. Rejection must supply a reason.
  const act = async (r, action, remarks) => {
    try {
      await api.transitionReport(r.id, action, remarks);
      setMsg(`"${r.title || "report"}" ${action}ed.`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };
  const reject = (r) => {
    const rm = window.prompt(`Reason for rejecting "${r.title || "this report"}" (required):`);
    if (rm == null) return;
    if (!rm.trim()) { window.alert("A reason is required to reject a report."); return; }
    act(r, "reject", rm.trim());
  };

  const isOwner = (r) => r.owner === user.id || r.owner_name === user.username;
  const can = (r, action) => canTransition(r.status, action, { role: user.role, isOwner: isOwner(r) }).ok;

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
        {msg && <div className="ok-box">{msg}</div>}
        {reports === null && !error && <div style={{color:"var(--muted)", fontSize:"13px"}}>Loading…</div>}

        {reports?.length === 0 && (
          <div style={{color:"var(--muted)", fontSize:"13px", padding:"24px 0"}}>
            No saved reports yet — start a chat and it will be saved automatically.
          </div>
        )}

        {(reports || []).map(r => (
          <div key={r.id} style={{
            display:"flex", alignItems:"center", gap:"8px", padding:"10px 12px",
            borderBottom:"1px solid var(--border)", flexWrap:"wrap"
          }}>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontWeight:"600", fontSize:"14px", color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                {r.title || "Untitled report"}
                {r.owner_name && r.owner_name !== user.username && (
                  <span style={{marginLeft:"8px", fontSize:"11px", color:"var(--accent)"}}>by {r.owner_name}</span>
                )}
              </div>
              <div style={{fontSize:"11px", color:"var(--muted)", display:"flex", alignItems:"center", gap:"6px", flexWrap:"wrap"}}>
                {r.control_no && (
                  <span style={{color:"var(--accent)", fontWeight:"600"}}>{r.control_no}</span>
                )}
                <span>{r.template_id}</span>
                <span>·</span>
                <span>{new Date(r.updated_at).toLocaleString()}</span>
                {r.photos_count ? <span>· {r.photos_count} photo{r.photos_count === 1 ? "" : "s"}</span> : null}
                <StatusBadge status={r.status}/>
              </div>
            </div>
            <button onClick={() => open(r)} className="mini-btn primary">Open</button>
            {can(r, "submit") && <button onClick={() => act(r, "submit")} className="mini-btn">Submit</button>}
            {can(r, "withdraw") && <button onClick={() => act(r, "withdraw")} className="mini-btn">Withdraw</button>}
            {can(r, "approve") && <button onClick={() => act(r, "approve")} className="mini-btn primary" style={{background:"#15803d", borderColor:"#15803d", color:"#fff"}}>Approve</button>}
            {can(r, "reject") && <button onClick={() => reject(r)} className="mini-btn danger">Reject</button>}
            {can(r, "reopen") && <button onClick={() => act(r, "reopen")} className="mini-btn">Reopen</button>}
            <button onClick={() => duplicate(r)} className="mini-btn">Duplicate</button>
            {r.status !== "approved" && <button onClick={() => remove(r)} className="mini-btn danger">Delete</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
