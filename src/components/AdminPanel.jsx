import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import TemplateBuilder from "./TemplateBuilder.jsx";

// Admin panel (Phase 8): personnel lists + template management.
export default function AdminPanel({ templates, onPersonnelSaved }) {
  const [section, setSection] = useState("personnel");
  const [builderFor, setBuilderFor] = useState(null); // template id or "new"

  return (
    <div style={{width:"100%", maxWidth:"760px"}}>
      <div style={{background:"#fff", borderRadius:"12px", boxShadow:"0 4px 24px rgba(0,0,100,0.15)", padding:"24px"}}>
        <div style={{fontSize:"18px", fontWeight:"700", color:"#0011aa", marginBottom:"4px"}}>⚙️ Administration</div>
        <div style={{display:"flex", gap:"8px", margin:"12px 0 16px"}}>
          {[["personnel","👥 Personnel"],["templates","🧩 Templates"]].map(([s, lbl]) => (
            <button key={s} onClick={() => setSection(s)} style={{
              padding:"6px 16px", borderRadius:"18px", border:"none", cursor:"pointer",
              fontSize:"12px", fontWeight:"600", background: section === s ? "#0033cc" : "#e8ecfa",
              color: section === s ? "#fff" : "#445"
            }}>{lbl}</button>
          ))}
        </div>

        {section === "personnel"
          ? <PersonnelEditor templates={templates} onSaved={onPersonnelSaved}/>
          : (
            <>
              {builderFor && (
                <TemplateBuilder
                  templateId={builderFor === "new" ? null : builderFor}
                  onClose={() => setBuilderFor(null)}
                  onSaved={(saved) => { setBuilderFor(null); if (onPersonnelSaved) onPersonnelSaved(); }}
                />
              )}
              <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"10px"}}>
                <div style={{fontSize:"13px", fontWeight:"600", color:"#333"}}>Existing templates</div>
                <button onClick={() => setBuilderFor("new")} style={{
                  marginLeft:"auto", padding:"6px 14px", borderRadius:"20px", border:"none", cursor:"pointer",
                  fontSize:"12px", fontWeight:"600", background:"#0033cc", color:"#fff"
                }}>＋ New template</button>
              </div>
              {(templates || []).map(t => (
                <div key={t.id} style={{display:"flex", alignItems:"center", gap:"10px", padding:"8px 10px", borderBottom:"1px solid #eef1fa"}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:"600", fontSize:"13px"}}>{t.name}</div>
                    <div style={{fontSize:"11px", color:"#888"}}>{t.id}{t.error ? ` — ⚠ ${t.error}` : ""}</div>
                  </div>
                  <button onClick={() => setBuilderFor(t.id)} style={editBtn}>Edit</button>
                </div>
              ))}
              <div style={{fontSize:"11px", color:"#999", marginTop:"14px"}}>
                Editing opens the template’s full JSON (advanced mode). New templates appear in everyone’s Template Picker right away.
              </div>
            </>
          )}
      </div>
    </div>
  );
}

function PersonnelEditor({ templates, onSaved }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id || "");
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!templateId) return;
    setStatus("");
    setError("");
    setRows(null);
    api.getPersonnel(templateId)
      .then(list => setRows(list.length ? list : [{ name: "", position: "" }]))
      .catch(e => setError(e.message));
  }, [templateId]);

  const updateRow = (i, key, value) => {
    setRows(prev => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  };

  const save = async () => {
    setStatus("Saving…");
    setError("");
    try {
      const saved = await api.savePersonnel(templateId, rows);
      setRows(saved.length ? saved : [{ name: "", position: "" }]);
      setStatus("✓ Saved");
      if (onPersonnelSaved) onPersonnelSaved();
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setError(e.message);
      setStatus("");
    }
  };

  return (
    <div style={{width:"100%", maxWidth:"720px"}}>
      <div style={{background:"#fff", borderRadius:"12px", boxShadow:"0 4px 24px rgba(0,0,100,0.15)", padding:"24px"}}>
        <div style={{fontSize:"18px", fontWeight:"700", color:"#0011aa", marginBottom:"4px"}}>⚙️ Administration</div>
        <div style={{fontSize:"12px", color:"#666", marginBottom:"16px"}}>
          Predefined personnel appear as dropdown choices for “Prepared by” / “Conformed by” on every report for this template.
        </div>

        <label style={{display:"block", fontSize:"12px", fontWeight:"600", marginBottom:"6px"}}>Template</label>
        <select value={templateId} onChange={e => setTemplateId(e.target.value)} style={{
          width:"100%", padding:"8px 10px", borderRadius:"8px", border:"1px solid #ccd5f0", fontSize:"14px", marginBottom:"16px"
        }}>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
        </select>

        {error && <div style={{background:"#fdecea", color:"#b71c1c", borderRadius:"8px", padding:"8px 12px", fontSize:"12px", marginBottom:"12px"}}>{error}</div>}

        {rows === null && !error && <div style={{color:"#666", fontSize:"13px"}}>Loading…</div>}
        {rows !== null && (
          <>
            <table style={{width:"100%", borderCollapse:"collapse", marginBottom:"12px"}}>
              <thead>
                <tr>
                  {["Name", "Position", ""].map(h => (
                    <th key={h} style={{textAlign:"left", fontSize:"11px", color:"#667", padding:"4px 8px", borderBottom:"2px solid #eef1fa"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{padding:"4px"}}>
                      <input value={r.name} onChange={e => updateRow(i, "name", e.target.value)} placeholder="JUAN D. DELA CRUZ" style={cellInput}/>
                    </td>
                    <td style={{padding:"4px"}}>
                      <input value={r.position} onChange={e => updateRow(i, "position", e.target.value)} placeholder="Regional Director" style={cellInput}/>
                    </td>
                    <td style={{padding:"4px", width:"32px", textAlign:"center"}}>
                      <button onClick={() => setRows(rows.filter((_, j) => j !== i))} title="Remove" style={{border:"none", background:"none", color:"#cc0000", cursor:"pointer", fontWeight:"bold"}}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{display:"flex", gap:"10px", alignItems:"center"}}>
              <button onClick={() => setRows([...rows, { name: "", position: "" }])} style={{
                padding:"7px 14px", borderRadius:"20px", border:"none", cursor:"pointer",
                fontSize:"12px", fontWeight:"600", background:"#e8f0fe", color:"#0033cc"
              }}>
                + Add person
              </button>
              <button onClick={save} style={{
                padding:"7px 20px", borderRadius:"20px", border:"none", cursor:"pointer",
                fontSize:"12px", fontWeight:"700", background:"#0033cc", color:"#fff"
              }}>
                Save
              </button>
              <span style={{fontSize:"12px", color:"#444"}}>{status}</span>
            </div>
            <div style={{fontSize:"11px", color:"#999", marginTop:"14px"}}>
              Changes apply immediately for everyone — no redeploy needed. Rows with an empty name are removed automatically.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const cellInput = {
  width:"100%", padding:"7px 10px", borderRadius:"6px", border:"1px solid #ccd5f0", fontSize:"13px"
};
const editBtn = {
  padding:"6px 14px", borderRadius:"20px", border:"none", cursor:"pointer",
  fontSize:"12px", fontWeight:"600", background:"#e8f0fe", color:"#0033cc"
};
