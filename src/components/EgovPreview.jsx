import React, { useState } from "react";
import { COLLAGE_LAYOUTS, collageGridStyle, collageSlotStyle } from "../lib/collage.js";

// eGov PH Post-Event Report preview (layout: "egov"). Mirrors the official
// Word/PDF form: info table → I. Overview → II. Challenges & Recommendation
// → III. Photo Documentation (with captions) → IV. eGovPH Material Condition
// matrix → Prepared/Reviewed/Approved signatories.
// Editing UX matches ReportPreview: click text to edit, dropdowns for
// choice/matrix/person fields, whole-array updates for list add/remove.

const BLUE = "#0000cc";

// Click-to-edit text, self-contained (same interaction as ReportPreview).
function Editable({ path, value, onUpdate, style, placeholder, multiline = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const start = () => { setDraft(value || ""); setEditing(true); };
  const save = () => { onUpdate(path, draft); setEditing(false); };

  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      onChange: e => setDraft(e.target.value),
      onBlur: save,
      style: { padding: "4px", width: "100%", border: `2px solid ${BLUE}`, borderRadius: "4px", fontFamily: "inherit", fontSize: "inherit" }
    };
    return multiline
      ? <textarea {...shared} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); }} rows={3}/>
      : <input {...shared} onKeyDown={e => e.key === "Enter" && save()}/>;
  }
  return (
    <span
      onClick={start}
      title="Click to edit"
      style={{ cursor: "pointer", background: "#f8f8f8", padding: "2px 4px", borderRadius: "3px", ...style }}
    >
      {value || <em style={{ color: "#999" }}>{placeholder || "Click to add"}</em>}
    </span>
  );
}

// Signatory block: personnel dropdown (from template.personnel) + free-text
// override, rendered inside its own table cell.
function PersonField({ label, id, data, personnel, onUpdate }) {
  const options = (personnel || []).filter(p => p && p.name);
  const knownIdx = options.findIndex(p => p.name === (data?.name || "") && (!p.position || p.position === (data?.position || "")));
  return (
    <div>
      <div style={{ fontWeight: "bold", marginBottom: "8px" }}>{label}</div>
      {options.length > 0 && (
        <select
          value={knownIdx >= 0 ? String(knownIdx) : "custom"}
          onChange={e => {
            if (e.target.value === "custom") { onUpdate(`${id}.name`, ""); onUpdate(`${id}.position`, ""); return; }
            const p = options[Number(e.target.value)];
            onUpdate(`${id}.name`, p.name);
            onUpdate(`${id}.position`, p.position || "");
          }}
          style={{ width: "100%", padding: "5px 8px", borderRadius: "6px", border: "1px solid #ccd5f0", fontSize: "13px", marginBottom: "8px", background: "#fff" }}
        >
          {options.map((p, i) => <option key={i} value={String(i)}>{p.name}{p.position ? ` — ${p.position}` : ""}</option>)}
          <option value="custom">✏️ Type your own…</option>
        </select>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={{ padding: "2px 0", fontSize: "11px", color: "#555", width: "56px" }}>Name:</td>
            <td style={{ fontWeight: "bold" }}><Editable path={`${id}.name`} value={data?.name || ""} onUpdate={onUpdate} placeholder="JUAN D. DELA CRUZ"/></td>
          </tr>
          <tr>
            <td style={{ padding: "2px 0", fontSize: "11px", color: "#555" }}>Position:</td>
            <td><Editable path={`${id}.position`} value={data?.position || ""} onUpdate={onUpdate} placeholder="Position"/></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const thStyle = { background: BLUE, color: "#fff", fontWeight: "bold", padding: "6px 10px", border: `1px solid ${BLUE}` };
const tdStyle = { padding: "6px 10px", border: `1px solid ${BLUE}` };

export default function EgovPreview({ data, photos, onUpdate, onRemovePhoto, headerImg, footerImg, template, photoLayout = "classic", onLayoutChange }) {
  const field = (id) => (template?.fields || []).find(f => f.id === id);
  const materialsField = field("materials");
  const captions = data.photoCaptions || [];

  const setListItem = (listId, index, key, value) => {
    const arr = (data[listId] || []).map((it, i) => (i === index ? { ...it, [key]: value } : it));
    onUpdate(listId, arr);
  };
  const addListItem = (listId, blank) =>
    onUpdate(listId, [...(data[listId] || []), blank]);
  const removeListItem = (listId, index) =>
    onUpdate(listId, (data[listId] || []).filter((_, i) => i !== index));

  return (
    <div id="report-preview" style={{ fontFamily: "'Times New Roman', serif", fontSize: "11pt", color: "#000", background: "#fff", padding: "40px 48px", maxWidth: "800px", margin: "0 auto" }}>
      <div style={{ marginBottom: "16px" }}>
        {headerImg ? (
          <img src={headerImg} alt="header" style={{ width: "100%" }}/>
        ) : (
          <div style={{ height: "80px", border: "2px dashed #ccc", display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}>
            No header image uploaded
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "15pt", letterSpacing: "1px", margin: "8px 0 16px" }}>
        POST-EVENT REPORT
      </div>

      {/* Event info table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "20px", border: `2px solid ${BLUE}` }}>
        <tbody>
          <tr>
            <td style={thStyle}>Name of Event</td>
            <td style={tdStyle} colSpan="3"><Editable path="eventName" value={data.eventName} onUpdate={onUpdate} placeholder="Event name"/></td>
          </tr>
          <tr>
            <td style={thStyle}>Date/Time</td>
            <td style={{ ...tdStyle, fontWeight: "bold" }} colSpan="3"><Editable path="dateTime" value={data.dateTime} onUpdate={onUpdate} placeholder="Date / time"/></td>
          </tr>
          <tr>
            <td style={thStyle}>Location</td>
            <td style={tdStyle} colSpan="3"><Editable path="location" value={data.location} onUpdate={onUpdate} placeholder="Venue / location"/></td>
          </tr>
          <tr>
            <td style={thStyle}>Time of Arrival</td>
            <td style={tdStyle}><Editable path="timeOfArrival" value={data.timeOfArrival} onUpdate={onUpdate} placeholder="e.g. 7:30am"/></td>
            <td style={thStyle}>Estimated No. of Participants</td>
            <td style={tdStyle}><Editable path="estimatedParticipants" value={data.estimatedParticipants} onUpdate={onUpdate} placeholder="e.g. 300"/></td>
          </tr>
          <tr>
            <td style={{ ...thStyle, verticalAlign: "top" }}>Representative/s</td>
            <td style={tdStyle}>
              {(data.representatives || []).length === 0 && <em style={{ color: "#999" }}>No representatives yet</em>}
              {(data.representatives || []).map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                  <span>{i + 1}.</span>
                  <Editable path={`representatives.${i}.name`} value={r.name} onUpdate={(p, v) => setListItem("representatives", i, "name", v)} placeholder="Name"/>
                  <button onClick={() => removeListItem("representatives", i)} title="Remove" style={{ border: "none", background: "none", color: "#cc0000", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                </div>
              ))}
              <button onClick={() => addListItem("representatives", { name: "" })} style={{ padding: "3px 10px", borderRadius: "12px", border: `1px solid ${BLUE}`, background: "#fff", color: BLUE, fontSize: "11px", fontWeight: "600", cursor: "pointer", marginTop: "4px" }}>+ Add</button>
            </td>
            <td style={thStyle}>Total No. of Registrants</td>
            <td style={tdStyle}><Editable path="totalRegistrants" value={data.totalRegistrants} onUpdate={onUpdate} placeholder="e.g. 254"/></td>
          </tr>
          <tr>
            <td style={thStyle}>Submitted Video and Photo Documentations?</td>
            <td style={tdStyle} colSpan="3">
              <select
                value={data.docsSubmitted || ""}
                onChange={e => onUpdate("docsSubmitted", e.target.value)}
                style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid #ccd5f0", fontSize: "13px", background: "#fff" }}
              >
                <option value="">—</option>
                {((field("docsSubmitted")?.options) || ["Yes", "No"]).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </td>
          </tr>
        </tbody>
      </table>

      {/* I. OVERVIEW */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontWeight: "bold", marginBottom: "8px" }}>I.&nbsp;&nbsp;&nbsp;OVERVIEW</div>
        {String(data.overview || "").split("\n").filter(p => p.trim()).map((p, i) => (
          <div key={i} style={{ textAlign: "justify", textIndent: "36px", marginBottom: "8px", lineHeight: "1.8" }}>
            <Editable path={`overview.${i}`} value={p} onUpdate={onUpdate} multiline/>
          </div>
        ))}
        {!String(data.overview || "").trim() && (
          <div style={{ color: "#999", fontStyle: "italic" }}>The AI writes this from your chat answers — or click to type.</div>
        )}
      </div>

      {/* II. CHALLENGES & RECOMMENDATION */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontWeight: "bold", marginBottom: "8px" }}>II.&nbsp;&nbsp;CHALLENGES &amp; RECOMMENDATION</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: "50%" }}>Issues/Concerns/Problems Encountered</th>
              <th style={thStyle}>Proposed Recommendations</th>
              <th style={{ ...thStyle, width: "28px" }}></th>
            </tr>
          </thead>
          <tbody>
            {(data.challenges || []).map((c, i) => (
              <tr key={i}>
                <td style={{ padding: "6px 8px", border: "1px solid #ccc", verticalAlign: "top" }}>
                  <Editable path={`challenges.${i}.issue`} value={c.issue} onUpdate={(p, v) => setListItem("challenges", i, "issue", v)} multiline placeholder="Issue encountered"/>
                </td>
                <td style={{ padding: "6px 8px", border: "1px solid #ccc", verticalAlign: "top" }}>
                  <Editable path={`challenges.${i}.recommendation`} value={c.recommendation} onUpdate={(p, v) => setListItem("challenges", i, "recommendation", v)} multiline placeholder="Proposed recommendation"/>
                </td>
                <td style={{ padding: "2px 4px", border: "1px solid #ccc", textAlign: "center" }}>
                  <button onClick={() => removeListItem("challenges", i)} title="Remove pair" style={{ border: "none", background: "none", color: "#cc0000", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                </td>
              </tr>
            ))}
            {(data.challenges || []).length === 0 && (
              <tr><td style={{ ...tdStyle, border: "1px solid #ccc", color: "#999", fontStyle: "italic", textAlign: "center" }} colSpan="3">No entries yet — the AI collects these in chat, or add one below.</td></tr>
            )}
          </tbody>
        </table>
        <button onClick={() => addListItem("challenges", { issue: "", recommendation: "" })} style={{ padding: "4px 12px", borderRadius: "14px", border: `1px solid ${BLUE}`, background: "#fff", color: BLUE, fontSize: "11px", fontWeight: "600", cursor: "pointer" }}>+ Add challenge / recommendation</button>
      </div>

      {/* III. PHOTO DOCUMENTATION */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontWeight: "bold", marginBottom: "8px", display: "flex", alignItems: "center", gap: "12px" }}>
          <span>III.&nbsp;&nbsp;PHOTO DOCUMENTATION</span>
          {photos.length > 0 && onLayoutChange && (
            <select value={photoLayout} onChange={e => onLayoutChange(e.target.value)} style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", border: "1px solid #ccd5f0", fontWeight: "normal" }} title="Photo collage layout">
              {COLLAGE_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          )}
        </div>
        {photos.length > 0 ? (
          <div style={{ ...collageGridStyle(photoLayout), borderWidth: "2px", gap: "4px", padding: "4px" }}>
            {photos.map((p, i) => {
              const slot = collageSlotStyle(photoLayout, i);
              return (
                <div key={i} style={{ ...slot, position: "relative", display: "flex", flexDirection: "column" }}>
                  <div style={{ flex: 1, overflow: "hidden", background: "#f5f5f5", position: "relative" }}>
                    <img src={p} alt={`Photo ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
                    {onRemovePhoto && (
                      <button onClick={() => onRemovePhoto(i)} title="Remove photo" style={{ position: "absolute", top: "4px", right: "4px", width: "22px", height: "22px", borderRadius: "50%", border: "none", background: "rgba(204,0,0,0.85)", color: "#fff", cursor: "pointer", fontWeight: "bold", lineHeight: 1 }}>✕</button>
                    )}
                  </div>
                  <Editable
                    path={`photoCaptions.${i}`}
                    value={captions[i] || ""}
                    onUpdate={onUpdate}
                    placeholder="Insert photo caption here."
                    style={{ display: "block", textAlign: "center", fontStyle: "italic", fontSize: "9pt", background: "transparent" }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ border: "2px dashed #aaa", padding: "40px", textAlign: "center", color: "#999", margin: "0 0 16px 24px" }}>Upload photos using the button above</div>
        )}
      </div>

      {/* IV. eGOVPH MATERIAL CONDITION */}
      {materialsField && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontWeight: "bold", marginBottom: "8px" }}>IV.&nbsp;&nbsp;eGOVPH MATERIAL CONDITION</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
            <thead>
              <tr>
                <th rowSpan="3" style={{ ...thStyle, verticalAlign: "middle" }}>Materials</th>
                <th colSpan={((materialsField.scales || []).length) * ((materialsField.options || []).length)} style={thStyle}>Condition Level</th>
              </tr>
              <tr>
                {(materialsField.scales || []).map(s => (
                  <th key={s.id} colSpan={(materialsField.options || []).length} style={{ ...thStyle, background: "#001a66", padding: "4px 6px", fontSize: "10pt" }}>{s.label}</th>
                ))}
              </tr>
              <tr>
                {(materialsField.scales || []).flatMap(s =>
                  (materialsField.options || []).map(o => (
                    <th key={`cell-${s.id}-${o.id}`} style={{ ...thStyle, background: "#eef", color: "#333", padding: "4px 6px", fontSize: "9pt", fontWeight: "normal" }}>{o.label}</th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {(materialsField.rows || []).map(r => (
                <tr key={r.id}>
                  <td style={{ padding: "6px 10px", border: "1px solid #ccc", fontWeight: "bold" }}>{r.label}</td>
                  {(materialsField.scales || []).map(s => {
                    const val = data.materials?.[r.id]?.[s.id] || "";
                    return (
                      <td key={`${r.id}-${s.id}`} colSpan={(materialsField.options || []).length} style={{ padding: "4px 6px", border: "1px solid #ccc", textAlign: "center" }}>
                        <select
                          value={val}
                          onChange={e => onUpdate(`materials.${r.id}.${s.id}`, e.target.value)}
                          style={{ width: "100%", border: "1px solid #ccd5f0", borderRadius: "4px", fontSize: "12px", padding: "3px 2px", background: "#fff" }}
                        >
                          <option value="">—</option>
                          {(materialsField.options || []).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {materialsField.note && <div style={{ fontSize: "10pt", fontStyle: "italic", marginBottom: "6px" }}>Note: {materialsField.note}</div>}
          {(materialsField.legend || []).length > 0 && (
            <div style={{ fontSize: "9pt", color: "#333", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "8px 12px", background: "#fafafa" }}>
              <div style={{ fontWeight: "bold", marginBottom: "2px" }}>Legend:</div>
              {materialsField.legend.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Signatories */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #ccc", marginBottom: "8px" }}>
        <tbody>
          <tr>
            {["preparedBy", "reviewedBy", "approvedBy"].filter(id => field(id)).map(id => (
              <td key={id} style={{ padding: "12px 16px", border: "1px solid #ccc", verticalAlign: "top", width: `${100 / ["preparedBy", "reviewedBy", "approvedBy"].filter(fid => field(fid)).length}%` }}>
                <PersonField
                  label={{ preparedBy: "Prepared by:", reviewedBy: "Reviewed by:", approvedBy: "Approved by:" }[id]}
                  id={id}
                  data={data[id]}
                  personnel={template.personnel}
                  onUpdate={onUpdate}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {/* Footer */}
      <div style={{ marginTop: "20px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "9pt", marginBottom: "6px" }}>
          <div style={{ fontStyle: "italic" }}>Post-Event Report{data.eventName ? ` | ${data.eventName}` : ""}</div>
          <div className="page-number-display" style={{ fontWeight: "bold", color: BLUE }}>PAGE 1 OF 1</div>
        </div>
        {footerImg ? (
          <img src={footerImg} alt="footer" style={{ width: "100%", display: "block", marginTop: "4px" }}/>
        ) : (
          <div style={{ height: "60px", border: "2px dashed #ccc", display: "flex", alignItems: "center", justifyContent: "center", color: "#999", marginTop: "4px" }}>
            No footer image uploaded
          </div>
        )}
      </div>
    </div>
  );
}
