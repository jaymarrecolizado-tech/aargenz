import React from "react";

// Header dropdown for selecting the active report template (Phase 2).
export default function TemplatePicker({ templates, templateId, onChange }) {
  if (!templates || templates.length < 1) return null;
  return (
    <select
      value={templateId}
      onChange={e => onChange(e.target.value)}
      title="Report template / project"
      style={{padding:"5px 8px", borderRadius:"14px", border:"none", fontSize:"11px", fontWeight:"600", background:"rgba(255,255,255,0.15)", color:"#fff", cursor:"pointer", outline:"none", marginLeft:"4px"}}
    >
      {templates.map(t => (
        <option key={t.id} value={t.id} style={{color:"#111"}}>{t.name}</option>
      ))}
    </select>
  );
}
