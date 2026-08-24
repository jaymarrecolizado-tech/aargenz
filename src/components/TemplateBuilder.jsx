import React, { useState, useRef } from "react";
import { api } from "../lib/api.js";
import { prepareLogoImage } from "../lib/images.js";

// Guided template builder (Phase 8.3, Option A) with an advanced raw-JSON
// mode. Creates or edits a template per DICT project; the server validates
// and writes templates/<id>/template.json.

const slugify = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const STANDARD_FIELDS = [
  { id: "dateTime", label: "Date and time" },
  { id: "mode", label: "Mode/Platform/Location" },
  { id: "controlNo", label: "Control number" }
];

const EXAMPLE_JSON = {
  id: "new-project",
  name: "New DICT Project Report",
  initialMessage: { role: "assistant", content: "Hello! Let's start — what is the title of the activity?" },
  fields: [
    { id: "title", label: "Activity title", type: "text" },
    { id: "dateTime", label: "Date and time", type: "text", example: "\"December 2-3, 2025 | 9:00am - 5:00pm\"" },
    { id: "facilitators", label: "Facilitators", type: "list", itemLabel: "Facilitator",
      collectNote: "Ask how many first, then each (Name, Office, Gender M/F).", doneAccepted: true,
      itemFields: [{ id: "name", type: "text" }, { id: "office", type: "text" }, { id: "gender", type: "text", example: "M/F" }] },
    { id: "beneficiaries", label: "Beneficiary breakdown", type: "beneficiaries",
      sectionTitle: "Beneficiaries",
      categories: [{ id: "ngas", label: "NGAs" }, { id: "lgus", label: "LGUs" }] },
    { id: "rationale", label: "What was the activity about?", target: "Rationale", type: "longform",
      styleNote: "Write in formal, professional government report style (2-3 paragraphs)" },
    { id: "preparedBy", label: "Prepared by", type: "person", manual: true },
    { id: "conformedBy", label: "Conformed by", type: "person", manual: true }
  ],
  personnel: []
};

export default function TemplateBuilder({ templateId, onClose, onSaved }) {
  const isEdit = !!templateId;
  const [mode, setMode] = useState("guided");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idLocked, setIdLocked] = useState(isEdit);
  const [initialMessage, setInitialMessage] = useState("");
  const [std, setStd] = useState({ dateTime: true, mode: true, controlNo: false });
  const [useFacilitators, setUseFacilitators] = useState(true);
  const [facilitatorLabel, setFacilitatorLabel] = useState("DICT Facilitators");
  const [useBeneficiaries, setUseBeneficiaries] = useState(true);
  const [benTitle, setBenTitle] = useState("NGAs / LGUs / SUCs and other Beneficiaries");
  const [benCats, setBenCats] = useState("ngas=NGAs, lgus=LGUs, sucs=SUCs, others=Others");
  const [rationale, setRationale] = useState("What was the activity about?");
  const [highlights, setHighlights] = useState("Key topics/modules discussed and outcomes");
  const [customFields, setCustomFields] = useState([]);
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Default header/footer branding (Phase 8.4). undefined = unchanged,
  // string (data URL) = imported image pending upload, null = removed.
  const [branding, setBranding] = useState({ header: undefined, footer: undefined });
  const [originalBranding, setOriginalBranding] = useState({ header: null, footer: null });
  const logoInputRef = useRef(null);
  const logoKindRef = useRef(null);

  // Editing an existing template → start from its live config in JSON mode.
  React.useEffect(() => {
    if (!isEdit) return;
    setMode("advanced"); // safest starting point for edits
    api.getTemplateConfig(templateId)
      .then(t => {
        setJsonText(JSON.stringify(t, null, 2));
        const orig = { header: t.headerLogo || null, footer: t.footerLogo || null };
        setOriginalBranding(orig);
      })
      .catch(e => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the preview shows: the pending change, or the saved value.
  const brandValue = (kind) => {
    const v = branding[kind];
    return v !== undefined ? v : originalBranding[kind];
  };

  const importLogo = async (kind, file) => {
    if (!file) return;
    const dataUrl = await prepareLogoImage(file);
    if (!dataUrl) {
      setError("Could not read that image file.");
      return;
    }
    setError("");
    setBranding(prev => ({ ...prev, [kind]: dataUrl }));
  };

  const clearLogo = (kind) => setBranding(prev => ({ ...prev, [kind]: null }));

  const buildConfig = () => {
    const fields = [{ id: "title", label: "Activity title", type: "text" }];
    for (const f of STANDARD_FIELDS) {
      if (std[f.id]) {
        const meta = {
          dateTime: { example: "\"December 2-3, 2025 | 9:00am - 5:00pm\"" },
          controlNo: { example: "\"eLGU-R2-12-04-2025-S157\"" }
        };
        fields.push({ id: f.id, label: f.label[0].toUpperCase() + f.label.slice(1), type: "text", ...(meta[f.id] || {}) });
      }
    }
    if (customFields.length) {
      for (const c of customFields) {
        if (c.label.trim()) fields.push({ id: slugify(c.label), label: c.label.trim(), type: "text" });
      }
    }
    if (useFacilitators) {
      fields.push({
        id: "facilitators", label: facilitatorLabel.trim() || "Facilitators", type: "list",
        itemLabel: "Facilitator",
        collectNote: "Ask how many facilitators first, then collect each one (Name, Office, Gender M/F).",
        doneAccepted: true,
        itemFields: [{ id: "name", type: "text" }, { id: "office", type: "text" }, { id: "gender", type: "text", example: "M/F" }]
      });
    }
    if (useBeneficiaries) {
      const cats = benCats.split(",").map(pair => {
        const [cid, label] = pair.split("=");
        return { id: (cid || "").trim(), label: (label || cid || "").trim() };
      }).filter(c => c.id);
      if (cats.length) {
        fields.push({
          id: "beneficiaries", label: "Beneficiary breakdown", type: "beneficiaries",
          sectionTitle: benTitle.trim() || cats.map(c => c.label).join(" / "), categories: cats
        });
      }
    }
    if (rationale.trim()) {
      fields.push({ id: "rationale", label: rationale.trim(), target: "Rationale", type: "longform",
        styleNote: "Write in formal, professional government report style (2-3 paragraphs)" });
    }
    if (highlights.trim()) {
      fields.push({ id: "highlights", label: highlights.trim(), target: "Highlights", type: "longform",
        styleNote: "Write in formal, professional government report style (2-3 paragraphs)" });
    }
    // Signatories are always manual (dropdown-filled, Phase 7.1).
    fields.push({ id: "preparedBy", label: "Prepared by", type: "person", manual: true });
    fields.push({ id: "conformedBy", label: "Conformed by", type: "person", manual: true });

    return {
      id: isEdit ? templateId : (id.trim() || slugify(name)),
      name: name.trim(),
      version: 1,
      initialMessage: {
        role: "assistant",
        content: initialMessage.trim() ||
          `Hello! I'll help you create your ${name.trim() || "report"}. Let's start — what is the **title of the activity**?`
      },
      fields,
      personnel: [],
      promptNotes: []
    };
  };

  const save = async () => {
    setError("");
    let config;
    try {
      config = mode === "guided" ? buildConfig() : JSON.parse(jsonText);
    } catch (e) {
      return setError("Invalid JSON: " + e.message);
    }
    if (!isEdit && !config.id) return setError("Template ID is required.");
    setBusy(true);
    try {
      // Upload/remove pending logos first so the saved config can reference
      // the final server-side URLs (Phase 8.4).
      for (const kind of ["header", "footer"]) {
        const pending = branding[kind];
        if (pending === undefined) continue;
        const key = kind === "header" ? "headerLogo" : "footerLogo";
        if (pending === null) {
          delete config[key];
          await api.deleteTemplateLogo(config.id, kind).catch(() => { /* file already gone */ });
        } else {
          const res = await api.uploadTemplateLogo(config.id, kind, pending);
          config[key] = res.url;
        }
      }
      const saved = await api.saveTemplate(config);
      await api.savePersonnel(config.id, Array.isArray(config.personnel) ? config.personnel : []);
      onSaved(saved);
    } catch (e) {
      setError(e.message + (e.details ? "\n" + e.details.join("\n") : ""));
    }
    setBusy(false);
  };

  return (
    <div style={{background:"#f8faff", border:"1px solid #dfe7fb", borderRadius:"10px", padding:"18px", marginBottom:"16px"}}>
      <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"12px"}}>
        <div style={{fontSize:"15px", fontWeight:"700", color:"#0011aa"}}>
          {isEdit ? `✏️ Edit template: ${templateId}` : "＋ New template"}
        </div>
        <button onClick={onClose} style={{marginLeft:"auto", border:"none", background:"none", cursor:"pointer", color:"#888"}}>✕ close</button>
      </div>

      {!isEdit && (
        <div style={{display:"flex", gap:"8px", marginBottom:"14px"}}>
          {[["guided","🧭 Guided"],["advanced","🔧 Advanced JSON"]].map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding:"6px 14px", borderRadius:"16px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600",
              background: mode === m ? "#0033cc" : "#e8ecfa", color: mode === m ? "#fff" : "#445"
            }}>{lbl}</button>
          ))}
        </div>
      )}

      {mode === "guided" ? (
        <>
          <Field label="Project / report name *">
            <input value={name} onChange={e => { setName(e.target.value); if (!idLocked) setId(slugify(e.target.value)); }} placeholder="e.g. eLGU Accomplishment Activity Report" style={inp}/>
          </Field>
          <Field label="Template ID (used in URLs and storage) *" hint={!isEdit && idLocked ? undefined : "lowercase letters, digits, dashes"}>
            <input value={isEdit ? templateId : id}
              onChange={e => { setId(e.target.value); setIdLocked(true); }}
              disabled={isEdit} placeholder="my-project" style={{...inp, ...(isEdit ? {background:"#eee"} : {})}}/>
          </Field>
          <Field label="Opening question shown in chat">
            <input value={initialMessage} onChange={e => setInitialMessage(e.target.value)} placeholder="Auto-generated from the name if left blank" style={inp}/>
          </Field>

          <div style={groupTitle}>Collected in chat</div>
          {STANDARD_FIELDS.map(f => (
            <label key={f.id} style={checkRow}>
              <input type="checkbox" checked={std[f.id]} onChange={e => setStd({ ...std, [f.id]: e.target.checked })}/>
              {" "}{f.label}
            </label>
          ))}
          <label style={checkRow}>
            <input type="checkbox" checked={useFacilitators} onChange={e => setUseFacilitators(e.target.checked)}/>{" "}Facilitators list
          </label>
          {useFacilitators && (
            <input value={facilitatorLabel} onChange={e => setFacilitatorLabel(e.target.value)} placeholder="Section label" style={{...inp, marginLeft:"24px", maxWidth:"360px"}}/>
          )}
          <label style={checkRow}>
            <input type="checkbox" checked={useBeneficiaries} onChange={e => setUseBeneficiaries(e.target.checked)}/>{" "}Beneficiary counts
          </label>
          {useBeneficiaries && (
            <div style={{marginLeft:"24px"}}>
              <input value={benTitle} onChange={e => setBenTitle(e.target.value)} placeholder="Table heading" style={{...inp, maxWidth:"360px"}}/>
              <input value={benCats} onChange={e => setBenCats(e.target.value)} placeholder="id=Label pairs, comma-separated" style={{...inp, maxWidth:"360px"}}/>
              <div style={{fontSize:"11px", color:"#888"}}>Format: <code>id=Label</code>, comma-separated</div>
            </div>
          )}
          <Field label="Rationale question"><input value={rationale} onChange={e => setRationale(e.target.value)} style={inp}/></Field>
          <Field label="Highlights question"><input value={highlights} onChange={e => setHighlights(e.target.value)} style={inp}/></Field>
          <Field label="Leave either question blank to skip that section.">
            <></>
          </Field>

          <div style={groupTitle}>Extra text questions</div>
          {customFields.map((c, i) => (
            <div key={i} style={{display:"flex", gap:"8px", marginBottom:"6px"}}>
              <input value={c.label} onChange={e => setCustomFields(customFields.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                placeholder="Question to ask in chat" style={{...inp, flex:1}}/>
              <button onClick={() => setCustomFields(customFields.filter((_, j) => j !== i))} style={{border:"none", background:"none", color:"#c00", cursor:"pointer"}}>✕</button>
            </div>
          ))}
          <button onClick={() => setCustomFields([...customFields, { label: "" }])} style={ghostBtn}>+ Add question</button>
        </>
      ) : (
        <>
          <Field label="Template JSON" hint="Full configuration — same format as templates/<id>/template.json">
            <textarea value={jsonText} onChange={e => setJsonText(e.target.value)} rows={16} spellCheck={false}
              placeholder={JSON.stringify(EXAMPLE_JSON, null, 2).slice(0, 400) + " …"}
              style={{...inp, fontFamily:"monospace", fontSize:"12px", whiteSpace:"pre"}}/>
          </Field>
        </>
      )}

      {/* Default branding (Phase 8.4): every report made with this template
          starts with these logos; users can still override them per session. */}
      <div style={groupTitle}>Default header &amp; footer logos</div>
      <div style={{display:"flex", gap:"14px", flexWrap:"wrap"}}>
        {["header", "footer"].map(kind => {
          const val = brandValue(kind);
          const pending = branding[kind];
          return (
            <div key={kind} style={{flex:"1 1 220px", maxWidth:"320px", border:"1px solid #dfe7fb", borderRadius:"10px", padding:"10px", background:"#fff"}}>
              <div style={{fontSize:"12px", fontWeight:"600", color:"#333", marginBottom:"6px"}}>
                {kind === "header" ? "Header logo" : "Footer logo"}
              </div>
              <div style={{height:"64px", border:"1px dashed #ccd5f0", borderRadius:"8px", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden", background:"#f6f8ff", marginBottom:"8px"}}>
                {val
                  ? <img src={val} alt={`${kind} logo`} style={{maxHeight:"100%", maxWidth:"100%", objectFit:"contain"}}/>
                  : <span style={{fontSize:"11px", color:"#98a4c8", padding:"0 8px", textAlign:"center"}}>No default — falls back to the built-in DICT banner</span>}
              </div>
              <div style={{display:"flex", gap:"6px", flexWrap:"wrap"}}>
                <button onClick={() => { logoKindRef.current = kind; logoInputRef.current?.click(); }} style={ghostBtn}>⬆ Import…</button>
                {val && (
                  <button onClick={() => clearLogo(kind)}
                    style={{...ghostBtn, borderColor:"#e8b0b0", color:"#c00"}}>✕ Remove</button>
                )}
              </div>
              <div style={{fontSize:"10.5px", color: pending != null ? "#0a7a2f" : "#999", marginTop:"6px", minHeight:"14px"}}>
                {pending ? "New image — applied on Save" : pending === null ? "Will be removed on Save" : ""}
              </div>
            </div>
          );
        })}
      </div>
      <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style={{display:"none"}}
        onChange={e => { importLogo(logoKindRef.current, e.target.files[0]); e.target.value = ""; }}/>

      {error && <div style={{background:"#fdecea", color:"#b71c1c", borderRadius:"8px", padding:"8px 12px", fontSize:"12px", margin:"10px 0", whiteSpace:"pre-wrap"}}>{error}</div>}

      <div style={{display:"flex", gap:"10px", marginTop:"14px"}}>
        <button onClick={save} disabled={busy} style={{
          padding:"9px 22px", borderRadius:"20px", border:"none", cursor: busy ? "wait" : "pointer",
          background:"#0033cc", color:"#fff", fontWeight:"700", fontSize:"13px"
        }}>
          {busy ? "Saving…" : isEdit ? "Save changes" : "Create template"}
        </button>
        <span style={{fontSize:"11px", color:"#999", alignSelf:"center"}}>
          Saved to the server immediately — appears in everyone’s Template Picker.
        </span>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{marginBottom:"12px"}}>
      <div style={{fontSize:"12px", fontWeight:"600", color:"#333", marginBottom:"4px"}}>
        {label}{hint && <span style={{fontWeight:"400", color:"#999", marginLeft:"6px"}}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const inp = {
  width:"100%", maxWidth:"480px", padding:"8px 10px", borderRadius:"8px",
  border:"1px solid #ccd5f0", fontSize:"13px"
};
const checkRow = { display:"block", fontSize:"13px", padding:"3px 0", cursor:"pointer" };
const groupTitle = { fontSize:"12px", fontWeight:"700", color:"#0011aa", margin:"14px 0 6px", textTransform:"uppercase", letterSpacing:"0.4px" };
const ghostBtn = {
  padding:"6px 14px", borderRadius:"20px", border:"1px dashed #aab8e8", background:"none",
  cursor:"pointer", fontSize:"12px", color:"#0033cc"
};
