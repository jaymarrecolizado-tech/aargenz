import React from "react";
import { COLLAGE_LAYOUTS, collageGridStyle, collageSlotStyle } from "../lib/collage.js";

// ILCDB After Activity Report preview (layout: "ilcdb"). Faithfully mirrors
// the official DICT Region II form:
//   - a single black-bordered "I. TRAINING DETAILS" table whose first row is
//     the section heading, then Course/Code/Date+Time/Duration/Venue/Course
//     Officer/Admin Asst./Tech Support/Resource Person/Platform+Mode/Target,
//     then Total Attendees, a (Sector | Total | Male | Female) beneficiary
//     table, and Issued Certificates.
//   - boxed sections for II. Rationale, III. Objectives (+ static intro line
//     + Topics Covered), V. Issues & VI. Recommendation side-by-side,
//     VII. Plans and Action Items, VIII. Photo Documentation.
//   - left-aligned Prepared by / Noted by signatories.
// Editing UX matches the other previews: click text to edit.

const INK = "#000";
const ctr = { textAlign: "center" };
const bold = { fontWeight: "bold" };
const cell = { padding: "5px 8px", border: `1px solid ${INK}`, verticalAlign: "middle" };

// Click-to-edit text, self-contained (same interaction as the other previews).
function Editable({ path, value, onUpdate, style, placeholder, multiline = false }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const start = () => { setDraft(value || ""); setEditing(true); };
  const save = () => { onUpdate(path, draft); setEditing(false); };

  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      onChange: e => setDraft(e.target.value),
      onBlur: save,
      style: { padding: "4px", width: "100%", border: "2px solid #0033cc", borderRadius: "4px", fontFamily: "inherit", fontSize: "inherit" }
    };
    return multiline
      ? <textarea {...shared} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); }} rows={4}/>
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

// A bordered section box: heading bar + body (mirrors the official form).
function Box({ heading, children, headStyle }) {
  return (
    <div style={{ border: `1px solid ${INK}`, marginBottom: "16px", background: "#fff" }}>
      <div style={{ ...bold, padding: "5px 10px", borderBottom: `1px solid ${INK}`, ...headStyle }}>{heading}</div>
      <div style={{ padding: "8px 12px" }}>{children}</div>
    </div>
  );
}

// Signatory: personnel dropdown + free-text override, left-aligned like the
// official form (bold uppercase name, italic position).
function Signatory({ label, id, data, personnel, onUpdate }) {
  const options = (personnel || []).filter(p => p && p.name);
  const knownIdx = options.findIndex(p => p.name === (data?.name || "") && (!p.position || p.position === (data?.position || "")));
  return (
    <div style={{ flex: 1 }}>
      <div style={{ marginBottom: "6px" }}>{label}</div>
      <div style={{ fontWeight: "bold", textTransform: "uppercase", marginBottom: "2px" }}>
        <Editable path={`${id}.name`} value={data?.name || ""} onUpdate={onUpdate} placeholder="NAME"/>
      </div>
      <div style={{ fontStyle: "italic" }}>
        <Editable path={`${id}.position`} value={data?.position || ""} onUpdate={onUpdate} placeholder="Position"/>
      </div>
      {options.length > 0 && (
        <select
          value={knownIdx >= 0 ? String(knownIdx) : "custom"}
          onChange={e => {
            if (e.target.value === "custom") { onUpdate(`${id}.name`, ""); onUpdate(`${id}.position`, ""); return; }
            const p = options[Number(e.target.value)];
            onUpdate(`${id}.name`, p.name);
            onUpdate(`${id}.position`, p.position || "");
          }}
          style={{ marginTop: "10px", display: "block", padding: "5px 8px", borderRadius: "6px", border: "1px solid #ccd5f0", fontSize: "12px", background: "#fff" }}
          title="Pick a saved signatory (optional)"
        >
          <option value="custom">✏️ Type your own…</option>
          {options.map((p, i) => <option key={i} value={String(i)}>{p.name}{p.position ? ` — ${p.position}` : ""}</option>)}
        </select>
      )}
    </div>
  );
}

export default function IlcdbPreview({ data, photos, onUpdate, onRemovePhoto, headerImg, footerImg, template, photoLayout = "classic", onLayoutChange }) {
  const b = data.beneficiaries || {};
  const cats = ((template?.fields || []).find(f => f.type === "beneficiaries")?.categories) || [];
  const num = v => Number(v) || 0;
  const cap = (c, g) => String(b[c.id]?.[g] ?? "");
  const totalMale = cats.reduce((s, c) => s + num(cap(c, "male")), 0);
  const totalFemale = cats.reduce((s, c) => s + num(cap(c, "female")), 0);
  const paras = value => String(value || "").split(/\n+/).map(s => s.trim()).filter(Boolean);

  const bulletList = (id, itemKey, placeholder) => (
    <>
      {(data[id] || []).map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "6px", marginBottom: "6px", paddingLeft: "14px", textAlign: "justify" }}>
          <span>•</span>
          <span style={{ flex: 1 }}>
            <Editable path={`${id}.${i}.${itemKey}`} value={it[itemKey]} onUpdate={(p, v) => onUpdate(id, (data[id] || []).map((x, j) => (j === i ? { ...x, [itemKey]: v } : x)))} placeholder={placeholder}/>
          </span>
          <button onClick={() => onUpdate(id, (data[id] || []).filter((_, j) => j !== i))} title="Remove" style={{ border: "none", background: "none", color: "#cc0000", cursor: "pointer", fontWeight: "bold" }}>✕</button>
        </div>
      ))}
      <button
        onClick={() => onUpdate(id, [...(data[id] || []), { [itemKey]: "" }])}
        style={{ marginLeft: "14px", padding: "3px 12px", borderRadius: "14px", border: "1px solid #000", background: "#fff", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
      >+ Add entry</button>
    </>
  );

  // Longform section body (editable paragraphs).
  const body = (path, value, placeholder) => (
    paras(value).length ? paras(value).map((p, i) => (
      <p key={i} style={{ margin: "0 0 6px", textAlign: "justify", lineHeight: 1.75 }}>
        <Editable path={path} value={p} onUpdate={onUpdate} multiline/>
      </p>
    )) : (
      <Editable path={path} value="" onUpdate={onUpdate} multiline placeholder={placeholder}/>
    )
  );

  // Objective list: static intro printed by the system; AI objective bullets
  // (if the model echoed the intro it is skipped).
  const objectiveLines = paras(data.objectives).filter(l => !/^\s*upon\s+completion\s+of\s+the\s+course/i.test(l));

  // 4-column editable number row used for each beneficiary category.
  const catRow = (c) => (
    <tr key={c.id}>
      <td style={{ ...cell, width: "22%", fontWeight: "bold" }}>{c.label}</td>
      <td style={{ ...cell, ...ctr }}>{num(cap(c, "male")) + num(cap(c, "female"))}</td>
      <td style={{ ...cell, ...ctr }}><Editable path={`beneficiaries.${c.id}.male`} value={cap(c, "male")} onUpdate={onUpdate} placeholder="0"/></td>
      <td style={{ ...cell, ...ctr }}><Editable path={`beneficiaries.${c.id}.female`} value={cap(c, "female")} onUpdate={onUpdate} placeholder="0"/></td>
    </tr>
  );

  return (
    <div id="report-preview" style={{ fontFamily: "'Times New Roman', serif", fontSize: "11pt", color: "#000", background: "#fff", padding: "40px 48px", maxWidth: "820px", margin: "0 auto" }}>
      <div style={{ marginBottom: "16px" }}>
        {headerImg ? (
          <img src={headerImg} alt="header" style={{ width: "100%" }}/>
        ) : (
          <div style={{ height: "80px", border: "2px dashed #ccc", display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}>
            No header image uploaded
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "15pt", letterSpacing: "1px", margin: "8px 0 18px" }}>AFTER ACTIVITY REPORT</div>

      {/* ONE black-bordered table; first row is the section heading */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: `1.5px solid ${INK}`, marginBottom: "18px" }}>
        <tbody>
          <tr>
            <td colSpan="4" style={{ ...cell, fontWeight: "bold", textAlign: "left" }}>I.&nbsp;&nbsp;&nbsp;TRAINING DETAILS</td>
          </tr>
          <tr>
            <td style={{ ...cell, width: "25%" }}><b>Course Title:</b></td>
            <td colSpan="3" style={cell}><Editable path="courseTitle" value={data.courseTitle} onUpdate={onUpdate} placeholder="Course title"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Course Code:</b></td>
            <td colSpan="3" style={cell}><Editable path="courseCode" value={data.courseCode} onUpdate={onUpdate} placeholder="Course code"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Date:</b></td>
            <td style={{ ...cell, width: "25%" }}><Editable path="dateTime" value={data.dateTime} onUpdate={onUpdate} placeholder="Date"/></td>
            <td style={cell}><b>Time:</b></td>
            <td style={cell}><Editable path="time" value={data.time} onUpdate={onUpdate} placeholder="Time"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Duration:</b></td>
            <td colSpan="3" style={cell}><Editable path="duration" value={data.duration} onUpdate={onUpdate} placeholder="e.g. 3 days"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Venue:</b></td>
            <td colSpan="3" style={cell}><Editable path="venue" value={data.venue} onUpdate={onUpdate} placeholder="Venue"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Course Officer:</b></td>
            <td colSpan="3" style={cell}><Editable path="courseOfficer" value={data.courseOfficer} onUpdate={onUpdate} placeholder="Name"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Admin Assistant:</b></td>
            <td colSpan="3" style={cell}><Editable path="adminAssistant" value={data.adminAssistant} onUpdate={onUpdate} placeholder="Name"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Technical Support:</b></td>
            <td colSpan="3" style={cell}><Editable path="technicalSupport" value={data.technicalSupport} onUpdate={onUpdate} placeholder="Name"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Resource Person:</b></td>
            <td colSpan="3" style={cell}><Editable path="resourcePerson" value={data.resourcePerson} onUpdate={onUpdate} placeholder="Name"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Platform Used:</b></td>
            <td style={cell}><Editable path="platformUsed" value={data.platformUsed} onUpdate={onUpdate} placeholder="e.g. Google Colab"/></td>
            <td style={cell}><b>Mode:</b></td>
            <td style={cell}><Editable path="mode" value={data.mode} onUpdate={onUpdate} placeholder="Face-to-Face / Online / Hybrid"/></td>
          </tr>
          <tr>
            <td style={cell}><b>Target Participants:</b></td>
            <td colSpan="3" style={cell}><Editable path="targetParticipants" value={data.targetParticipants} onUpdate={onUpdate} placeholder="e.g. DICT Personnel"/></td>
          </tr>

          {/* Total attendees (auto-computed, sex-disaggregated) */}
          <tr>
            <td style={cell}><b>Total # of Attendees:</b><br /><span style={{ fontSize: "9pt", fontWeight: "normal" }}>(with/without submitted Evaluation Form/Output)</span></td>
            <td style={{ ...cell, ...ctr }}><b>{totalMale + totalFemale}</b></td>
            <td style={cell}><div style={ctr}>Male<br/><b>{totalMale}</b></div></td>
            <td style={cell}><div style={ctr}>Female<br/><b>{totalFemale}</b></div></td>
          </tr>

          {/* Sex-disaggregated beneficiary table */}
          <tr>
            <td colSpan="4" style={{ ...cell, fontWeight: "bold", textAlign: "center" }}>Number of Beneficiary/ies with Sex Disaggregation</td>
          </tr>
          <tr>
            <td style={{ ...cell, fontWeight: "bold" }}>Sector Category</td>
            <td style={{ ...cell, ...bold, ...ctr }}>Total</td>
            <td style={{ ...cell, ...bold, ...ctr }}>Male</td>
            <td style={{ ...cell, ...bold, ...ctr }}>Female</td>
          </tr>
          {cats.map(catRow)}

          {/* Issued certificates */}
          <tr>
            <td style={cell}><b>Total # of Issued Certificates:</b><br /><span style={{ fontSize: "9pt", fontWeight: "normal" }}>(with submitted Evaluation Form/Output)</span></td>
            <td colSpan="3" style={cell}><Editable path="certificatesIssued" value={data.certificatesIssued} onUpdate={onUpdate} placeholder="e.g. 17 (Male: 10, Female: 7)"/></td>
          </tr>
        </tbody>
      </table>
<Box heading="II.&nbsp;&nbsp;&nbsp;RATIONALE">
        {body("rationale", data.rationale, "Course overview…")}
      </Box>

      <Box heading="III.&nbsp;&nbsp;&nbsp;OBJECTIVES">
        <div style={{ fontStyle: "italic", marginBottom: "8px" }}>Upon completion of the course, participants will be able to learn:</div>
        {objectiveLines.length > 0 ? objectiveLines.map((line, i) => (
          <div key={i} style={{ paddingLeft: "14px", marginBottom: "6px", textAlign: "justify", lineHeight: 1.6 }}>• {line.replace(/^[•●]\s*/, "").trim()}</div>
        )) : (
          <Editable path="objectives" value="" onUpdate={onUpdate} multiline placeholder="• understand the fundamentals of AI; • …"/>
        )}
        <div style={{ fontWeight: "bold", marginTop: "14px", marginBottom: "6px" }}>Topics Covered:</div>
        {body("topicsCovered", data.topicsCovered, "Modules covered and how the sessions were organized…")}
      </Box>

      {/* V. Issues & VI. Recommendation — side by side */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${INK}`, marginBottom: "16px" }}>
        <tbody>
          <tr>
            <td style={{ width: "50%", border: `1px solid ${INK}`, verticalAlign: "top" }}>
              <div style={{ fontWeight: "bold", padding: "5px 10px", borderBottom: `1px solid ${INK}` }}>V.&nbsp;&nbsp;&nbsp;ISSUES AND CONCERNS</div>
              <div style={{ padding: "8px 10px" }}>{bulletList("issues", "issue", "Describe the issue/concern")}</div>
            </td>
            <td style={{ width: "50%", border: `1px solid ${INK}`, verticalAlign: "top" }}>
              <div style={{ fontWeight: "bold", padding: "5px 10px", borderBottom: `1px solid ${INK}` }}>VI.&nbsp;&nbsp;&nbsp;RECOMMENDATION</div>
              <div style={{ padding: "8px 10px" }}>{bulletList("recommendations", "recommendation", "Describe the recommendation")}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <Box heading="VII.&nbsp;&nbsp;PLANS AND ACTION ITEMS (NEXT STEPS)">
        {body("plansActions", data.plansActions, "Next steps…")}
      </Box>
      {/* VIII. PHOTO DOCUMENTATION */}
      <Box heading="VIII.&nbsp;&nbsp;PHOTO DOCUMENTATION">
        <div style={{ marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
          {photos.length > 0 && onLayoutChange && (
            <select value={photoLayout} onChange={e => onLayoutChange(e.target.value)} style={{ fontSize: "12px", padding: "3px 8px", borderRadius: "6px", border: "1px solid #ccd5f0" }} title="Photo collage layout">
              {COLLAGE_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          )}
          {photos.length === 0 && <div style={{ color: "#999", fontStyle: "italic" }}>No photos yet.</div>}
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
                  <div style={{ textAlign: "center", fontWeight: "bold", fontSize: "9pt", margin: "2px 0" }}>
                    <Editable path={`photoCaptions.${i}`} value={(data.photoCaptions || [])[i] || ""} onUpdate={onUpdate} placeholder="Day 1 October 29, 2024"/>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ border: "2px dashed #aaa", padding: "40px", textAlign: "center", color: "#999" }}>Upload photos using the button above</div>
        )}
      </Box>

      {/* Signatories — left aligned */}
      <div style={{ display: "flex", gap: "40px", marginTop: "4px", marginBottom: "8px" }}>
        <Signatory label="Prepared by:" id="preparedBy" data={data.preparedBy} personnel={template.personnel} onUpdate={onUpdate}/>
        <Signatory label="Noted by:" id="notedBy" data={data.notedBy} personnel={template.personnel} onUpdate={onUpdate}/>
      </div>

      {/* Footer */}
      <div style={{ marginTop: "20px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "9pt", marginBottom: "6px" }}>
          <div style={{ fontStyle: "italic" }}>ILCD-R2 After-Activity Report{data.courseTitle ? ` | ${data.courseTitle}` : ""}</div>
          <div className="page-number-display" style={{ fontWeight: "bold" }}>PAGE 1 OF 1</div>
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