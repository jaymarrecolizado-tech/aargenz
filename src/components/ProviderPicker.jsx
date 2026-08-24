import React from "react";

// AI provider controls in the header: provider mode (Auto/Local/Groq) and the
// local model name override.
export default function ProviderPicker({ aiOverrides, defaults, onChange }) {
  return (
    <div style={{display:"flex", alignItems:"center", gap:"6px", marginLeft:"8px"}} title="AI model: Auto = local model first, Groq fallback; Local = local only. Needs a local server (e.g. Ollama) running for local mode.">
      <select
        value={aiOverrides.AI_PROVIDER || defaults.AI_PROVIDER}
        onChange={e => onChange({ AI_PROVIDER: e.target.value })}
        style={{padding:"5px 8px", borderRadius:"14px", border:"none", fontSize:"11px", fontWeight:"600", background:"rgba(255,255,255,0.15)", color:"#fff", cursor:"pointer", outline:"none"}}
      >
        <option value="auto" style={{color:"#111"}}>Auto</option>
        <option value="local" style={{color:"#111"}}>Local</option>
        <option value="groq" style={{color:"#111"}}>Groq</option>
      </select>
      <input
        value={aiOverrides.LOCAL_MODEL || defaults.LOCAL_MODEL}
        onChange={e => onChange({ LOCAL_MODEL: e.target.value })}
        placeholder="local model"
        title="Local model name served by your local server (e.g. qwen3:14b)"
        style={{width:"110px", padding:"5px 8px", borderRadius:"14px", border:"none", fontSize:"11px", background:"rgba(255,255,255,0.15)", color:"#fff", outline:"none"}}
      />
    </div>
  );
}
