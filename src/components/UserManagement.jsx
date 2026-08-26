import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// User account management (Phase 9, admin only): create accounts, change
// roles, reset passwords and remove users. Server enforces the same guards
// (no self-delete/demotion, last-admin protection) — this UI just reflects it.
export default function UserManagement({ currentUser }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ username: "", password: "", role: "encoder" });
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.listUsers().then(setUsers).catch(e => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const create = async () => {
    setError(""); setStatus("");
    setBusy(true);
    try {
      const name = form.username.trim();
      await api.createUser(name, form.password, form.role);
      setStatus(`Created ${name} (${form.role})`);
      setForm({ username: "", password: "", role: "encoder" });
      load();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  const changeRole = async (u, role) => {
    setError(""); setStatus("");
    try {
      await api.setUserRole(u.id, role);
      setStatus(`${u.username} is now ${role}`);
      load();
    } catch (e) {
      setError(e.message); // e.g. cannot demote yourself / last admin
    }
  };

  const resetPassword = async (u) => {
    setError(""); setStatus("");
    const pw = window.prompt(`New password for ${u.username} (min 6 characters):`);
    if (!pw) return;
    try {
      await api.resetUserPassword(u.id, pw);
      setStatus(`Password reset for ${u.username} — their sessions were signed out`);
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (u) => {
    setError(""); setStatus("");
    const n = u.reports ?? 0;
    if (!window.confirm(
      `Delete account "${u.username}"?\n\nTheir ${n} saved report(s) will be KEPT in My Reports but no longer owned by anyone. This cannot be undone.`
    )) return;
    try {
      await api.deleteUser(u.id);
      setStatus(`Deleted ${u.username}`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div>
      {/* Create account */}
      <div style={{fontSize:"13px", fontWeight:"600", color:"var(--text)", marginBottom:"8px"}}>Add user</div>
      <div style={{display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:"16px"}}>
        <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
          placeholder="username" style={{...cellInput, width:"160px"}}/>
        <input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
          placeholder="password (min 6)" type="password" style={{...cellInput, width:"170px"}}/>
        <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
          className="mini-btn" style={{padding:"7px 10px"}}>
          <option value="encoder">encoder</option>
          <option value="admin">admin</option>
        </select>
        <button onClick={create} disabled={busy || !form.username.trim() || form.password.length < 6}
          className="mini-btn primary" style={{opacity: busy ? 0.6 : 1}}>
          {busy ? "Adding…" : "+ Add user"}
        </button>
      </div>

      {error && <div className="err-box">{error}</div>}
      {status && <div className="ok-box">{status}</div>}
      {users === null && !error && <div style={{color:"var(--muted)", fontSize:"13px"}}>Loading…</div>}
      {users !== null && <UsersTable users={users} currentUser={currentUser} onRole={changeRole} onReset={resetPassword} onDelete={remove}/>}
      <div style={{fontSize:"11px", color:"var(--muted)", marginTop:"14px"}}>
        Password resets sign the user out everywhere. Deleting an account keeps their reports (government records) but they can no longer sign in.
      </div>
    </div>
  );
}

const cellInput = {
  padding:"7px 10px", borderRadius:"6px", border:"1px solid var(--border-strong)",
  background:"var(--surface)", color:"var(--text)", fontSize:"13px", outline:"none"
};

function UsersTable({ users, currentUser, onRole, onReset, onDelete }) {
  return (
    <div style={{border:"1px solid var(--border)", borderRadius:"8px", overflowX:"auto"}}>
      <table style={{width:"100%", borderCollapse:"collapse", fontSize:"12px"}}>
        <thead>
          <tr style={{position:"sticky", top:0, background:"var(--surface)"}}>
            {["User", "Role", "Reports", "Sessions", "Created", "Actions"].map(h => (
              <th key={h} style={{textAlign:"left", color:"var(--muted)", padding:"8px 10px", borderBottom:"1px solid var(--border)", fontWeight:"600"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map(u => {
            const self = u.id === currentUser?.id;
            return (
              <tr key={u.id} style={{borderBottom:"1px solid var(--border)"}}>
                <td style={{padding:"7px 10px", fontWeight:"600", color:"var(--text)", whiteSpace:"nowrap"}}>
                  {u.username}{self && <span style={{marginLeft:"6px", color:"var(--muted)", fontWeight:"400"}}>(you)</span>}
                </td>
                <td style={{padding:"7px 10px"}}>
                  <select value={u.role} disabled={self}
                    onChange={e => onRole(u, e.target.value)}
                    className="mini-btn" style={{padding:"4px 8px", opacity: self ? 0.55 : 1}}
                    title={self ? "You cannot change your own role" : "Change role"}>
                    <option value="encoder">encoder</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td style={{padding:"7px 10px", color:"var(--muted)"}}>{u.reports ?? 0}</td>
                <td style={{padding:"7px 10px", color:"var(--muted)"}}>{u.sessions ?? 0}</td>
                <td style={{padding:"7px 10px", color:"var(--muted)", whiteSpace:"nowrap"}}>
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td style={{padding:"7px 10px", whiteSpace:"nowrap"}}>
                  <button onClick={() => onReset(u)} className="mini-btn" title="Set a new password for this user">Reset password</button>
                  {" "}
                  <button onClick={() => onDelete(u)} disabled={self} className="mini-btn danger"
                    style={{opacity: self ? 0.45 : 1}}
                    title={self ? "You cannot delete your own account" : "Delete this account"}>
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}