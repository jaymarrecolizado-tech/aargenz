import React from "react";

// AI provider controls in the header: provider mode and the local model name.
//   Contingency = cloud first, local model as the offline last resort (use this
//                 in production so reports keep flowing when credit runs out)
//   Auto        = local model first, cloud fallback (for fine-tune iteration)
//   Local       = local only;  Groq = cloud only
// Needs a local server (e.g. Ollama) running for any mode that can reach local.
export default function ProviderPicker({ aiOverrides, defaults, onChange }) {
  return (
    <div style={{display:"flex", alignItems:"center", gap:"6px", marginLeft:"8px"}} title="AI model routing. Contingency = cloud first, local model as offline fallback. Auto = local first. Local = local only. Needs a local server (e.g. Ollama) for local modes — see LOCAL_AI_CONTINGENCY.md.">
      <select
        value={aiOverrides.AI_PROVIDER || defaults.AI_PROVIDER}
        onChange={e => onChange({ AI_PROVIDER: e.target.value })}
        className="hselect"
      >
        <option value="contingency">Contingency</option>
        <option value="auto">Auto</option>
        <option value="local">Local</option>
        <option value="groq">Groq</option>
      </select>
      <input
        value={aiOverrides.LOCAL_MODEL || defaults.LOCAL_MODEL}
        onChange={e => onChange({ LOCAL_MODEL: e.target.value })}
        placeholder="local model"
        title="Local model name served by your local server (e.g. qwen3:8b, qwen3:14b)"
        className="hselect"
        style={{width:"110px"}}
      />
    </div>
  );
}
