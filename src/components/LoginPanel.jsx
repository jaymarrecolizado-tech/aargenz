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
      background:"linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f5f0ff 100%)",
      fontFamily:"'Segoe UI', system-ui, sans-serif"
    }}>
      <form onSubmit={submit} style={{
        background:"#fff", borderRadius:"12px", boxShadow:"0 4px 24px rgba(0,0,100,0.15)",
        padding:"32px", width:"340px"
      }}>
        <div style={{fontSize:"20px", fontWeight:"900", color:"#0011aa", marginBottom:"4px"}}>
          <span style={{color:"#66aaff"}}>e</span>LGU <span style={{color:"#ffaa33"}}>e</span><span style={{color:"#66ff88"}}>GOV</span><span style={{color:"#ff6666", fontSize:"12px"}}>PH</span>
        </div>
        <div style={{fontSize:"13px", color:"#666", marginBottom:"20px"}}>AAR Generator — sign in to continue</div>

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
          width:"100%", padding:"10px", borderRadius:"20px", border:"none", cursor: busy ? "wait" : "pointer",
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

const lbl = { display:"block", fontSize:"12px", fontWeight:"600", color:"#333", marginBottom:"12px" };
const inp = {
  display:"block", width:"100%", marginTop:"4px", padding:"9px 12px", borderRadius:"8px",
  border:"1px solid #ccd5f0", fontSize:"14px"
};
