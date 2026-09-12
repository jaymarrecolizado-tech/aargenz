import React, { useState } from "react";
import { api } from "../lib/api.js";

// Self-service password change (P0). Previously only an admin could reset a
// password, so an encoder who suspected a leak had no way to rotate it.
// Changing it revokes every other session, so other devices are signed out.
export default function ChangePassword({ onClose }) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    setError("");
    if (newPassword.length < 6) return setError("New password must be at least 6 characters.");
    if (newPassword !== confirmPassword) return setError("The two new passwords do not match.");
    if (newPassword === currentPassword) return setError("New password must be different from the current one.");
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setDone(true);
    } catch (err) {
      setError(err.message || "Could not change the password.");
    } finally {
      setBusy(false);
    }
  };

  const field = (label, value, setter, autoComplete) => (
    <div style={{marginBottom:"12px"}}>
      <label style={{display:"block", fontSize:"12px", fontWeight:"600", marginBottom:"5px"}}>{label}</label>
      <input
        type="password"
        value={value}
        onChange={e => setter(e.target.value)}
        autoComplete={autoComplete}
        style={{width:"100%", padding:"9px 12px", borderRadius:"8px", border:"1px solid #ccd5f0", fontSize:"14px"}}
      />
    </div>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position:"absolute", inset:0, background:"rgba(16,24,40,0.45)",
        display:"flex", alignItems:"center", justifyContent:"center", zIndex:50, padding:"16px"
      }}
    >
      <form
        className="panel"
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        style={{width:"100%", maxWidth:"380px", padding:"22px", background:"var(--surface)"}}
      >
        <div style={{fontSize:"16px", fontWeight:"700", color:"var(--text)", marginBottom:"4px"}}>Change password</div>
        {done ? (
          <>
            <div className="ok-box" style={{marginTop:"12px"}}>
              Password changed. Every other device has been signed out.
            </div>
            <div style={{display:"flex", justifyContent:"flex-end"}}>
              <button type="button" onClick={onClose} className="mini-btn primary">Close</button>
            </div>
          </>
        ) : (
          <>
            <div style={{fontSize:"12px", color:"var(--muted)", marginBottom:"16px"}}>
              You will stay signed in here; other devices are signed out.
            </div>
            {error && <div className="err-box">{error}</div>}
            {field("Current password", currentPassword, setCurrent, "current-password")}
            {field("New password", newPassword, setNew, "new-password")}
            {field("Confirm new password", confirmPassword, setConfirm, "new-password")}
            <div style={{display:"flex", gap:"8px", justifyContent:"flex-end", marginTop:"18px"}}>
              <button type="button" onClick={onClose} className="mini-btn">Cancel</button>
              <button type="submit" className="mini-btn primary" disabled={busy}>
                {busy ? "Saving…" : "Change password"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
