import React, { useState } from "react";
import { api } from "../lib/api.js";

// Login / registration gate shown before any app content (Phase 4.4).
export default function LoginPanel({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password) return setError("Username and password are required.");
    if (mode === "register" && password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const user = mode === "login"
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password);
      onAuth(user);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div style={{
      minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
      background:"#f5f6f8",
      fontFamily:"-apple-system, 'Segoe UI', system-ui, Roboto, sans-serif"
    }}>
      <form onSubmit={submit} style={{
        background:"#fff", border:"1px solid #e4e7ec", borderRadius:"10px",
        boxShadow:"0 1px 2px rgba(16,24,40,0.05)",
        padding:"32px", width:"340px"
      }}>
        <div style={{fontSize:"19px", fontWeight:"700", color:"#111a2e", marginBottom:"4px"}}>
          <span style={{color:"#2563eb"}}>DICT</span> <span style={{color:"#d97706"}}>R2</span> AAR Generator
        </div>
        <div style={{fontSize:"13px", color:"#667085", marginBottom:"20px"}}>DICT Region 2 — sign in to continue</div>

        <label style={lbl}>Username
          <input value={username} onChange={e => setUsername(e.target.value)} autoFocus style={inp}/>
        </label>
        <label style={lbl}>Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={inp}/>
        </label>
        {mode === "register" && (
          <label style={lbl}>Confirm password
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} style={inp}/>
          </label>
        )}

        {error && <div style={{background:"#fdecea", color:"#b71c1c", borderRadius:"8px", padding:"8px 12px", fontSize:"12px", marginBottom:"12px"}}>{error}</div>}

        <button disabled={busy} type="submit" style={{
          width:"100%", padding:"10px", borderRadius:"7px", border:"none", cursor: busy ? "wait" : "pointer",
          background:"#0033cc", color:"#fff", fontWeight:"600", fontSize:"14px", marginBottom:"12px"
        }}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }} style={{
          width:"100%", padding:"6px", background:"none", border:"none", color:"#0033cc",
          cursor:"pointer", fontSize:"12px"
        }}>
          {mode === "login" ? "No account yet? Register" : "Already have an account? Sign in"}
        </button>
      </form>
      <style>{`* { box-sizing: border-box; }`}</style>
    </div>
  );
}

const lbl = { display:"block", fontSize:"12px", fontWeight:"600", color:"#344054", marginBottom:"12px" };
const inp = {
  display:"block", width:"100%", marginTop:"4px", padding:"9px 12px", borderRadius:"7px",
  border:"1px solid #d0d5dd", fontSize:"14px", outline:"none"
};
