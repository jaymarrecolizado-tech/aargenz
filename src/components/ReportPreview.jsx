import React, { useState } from "react";
import { COLLAGE_LAYOUTS, collageGridStyle, collageSlotStyle } from "../lib/collage.js";
import { countGenders } from "../lib/report.js";

// Photo slot with a remove (✕) button when onRemove is provided.
function PhotoSlot({ src, index, onRemove }) {
  return (
    <div style={{position:"relative", width:"100%", height:"100%"}}>
      <img src={src} alt={`Photo ${index+1}`} style={{width:"100%", height:"100%", objectFit:"cover", display:"block"}}/>
      {onRemove && (
        <button onClick={() => onRemove(index)} title="Remove photo" style={{position:"absolute", top:"4px", right:"4px", width:"22px", height:"22px", borderRadius:"50%", border:"none", background:"rgba(204,0,0,0.85)", color:"#fff", cursor:"pointer", fontWeight:"bold", lineHeight:1}}>✕</button>
      )}
    </div>
  );
}

export default function ReportPreview({ data, photos, onUpdate, onAddFacilitator, onRemoveFacilitator, onRemovePhoto, headerImg, footerImg, template, photoLayout = "classic", onLayoutChange }) {
  const [editField, setEditField] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editDeep, setEditDeep] = useState(null);

  // Phase 7.2: signatories are picked from the template's predefined
  // personnel list (never collected by the AI). Free-text editing is ALWAYS
  // available below the dropdown, so custom names just work — picking from
  // the list simply overwrites both fields.
  function PersonPicker({ id, data, personnel, onUpdate }) {
    const options = (personnel || []).filter(p => p && p.name);
    const knownIdx = options.findIndex(p => p.name === (data?.name || "") && (!p.position || p.position === (data?.position || "")));
    return (
      <>
        {options.length > 0 && (
          <select
            value={knownIdx >= 0 ? String(knownIdx) : "custom"}
            onChange={e => {
              if (e.target.value === "custom") {
                onUpdate(`${id}.name`, "");
                onUpdate(`${id}.position`, "");
                return;
              }
              const p = options[Number(e.target.value)];
              onUpdate(`${id}.name`, p.name);
              onUpdate(`${id}.position`, p.position || "");
            }}
            style={{
              width:"100%", padding:"5px 8px", borderRadius:"6px", border:"1px solid #ccd5f0",
              fontSize:"13px", marginBottom:"8px", background:"#fff"
            }}
          >
            {options.map((p, i) => (
              <option key={i} value={String(i)}>{p.name}{p.position ? ` — ${p.position}` : ""}</option>
            ))}
            <option value="custom">✏️ Type your own…</option>
          </select>
        )}
        <table style={{width:"100%", borderCollapse:"collapse"}}>
          <tbody>
            <tr>
              <td style={{padding:"2px 0", fontSize:"11px", color:"#555", width:"64px"}}>Name:</td>
              <td style={{fontWeight:"bold"}}>{renderEditable(`${id}.name`, data?.name || "", `${id}.name`)}</td>
            </tr>
            <tr>
              <td style={{padding:"2px 0", fontSize:"11px", color:"#555"}}>Position:</td>
              <td>{renderEditable(`${id}.position`, data?.position || "", `${id}.position`)}</td>
            </tr>
          </tbody>
        </table>
      </>
    );
  }

  const benField = (template?.fields || []).find(f => f.type === "beneficiaries");
  const cats = benField?.categories || [];
  const personIds = new Set((template?.fields || []).filter(f => f.type === "person").map(f => f.id));

  // Tolerant tally (countGenders) — "Male"/"F"/" m " all count; strict M/F
  // equality used to zero these whenever the spelling varied.
  const { male: facilitatorMale, female: facilitatorFemale } = countGenders(data.facilitators);

  const b = data.beneficiaries;
  const sumCat = (g) => cats.reduce((s, c) => s + (Number(b?.[c.id]?.[g]) || 0), 0);
  const benMale = sumCat("male");
  const benFemale = sumCat("female");
  const totalMale = facilitatorMale + benMale;
  const totalFemale = facilitatorFemale + benFemale;

  const startEdit = (field, value, deep = null) => {
    setEditField(field);
    setEditValue(value || "");
    setEditDeep(deep);
  };

  const saveEdit = () => {
    if (editDeep) {
      onUpdate(editDeep, editValue);
    } else {
      onUpdate(editField, editValue);
    }
    setEditField(null);
    setEditValue("");
    setEditDeep(null);
  };

  const renderEditable = (field, value, deep = null) => {
    if (editField === field && editDeep === deep) {
      return (
        <input
          autoFocus
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={e => e.key === "Enter" && saveEdit()}
          style={{padding:"4px", width:"100%", border:"2px solid #0033cc", borderRadius:"4px"}}
        />
      );
    }
    return <span onClick={() => startEdit(field, value, deep)} style={{cursor:"pointer", background:editField===field?"#ffffcc":(onUpdate?"#f8f8f8":""), padding:"2px 4px", borderRadius:"3px"}}>{value}</span>;
  };

  return (
    <div id="report-preview" style={{fontFamily:"'Times New Roman', serif", fontSize:"11pt", color:"#000", background:"#fff", padding:"40px 48px", maxWidth:"800px", margin:"0 auto"}}>
      <div style={{marginBottom:"16px"}}>
        {headerImg ? (
          <img src={headerImg} alt="header" style={{width:"100%"}}/>
        ) : (
          <div style={{height:"80px", border:"2px dashed #ccc", display:"flex", alignItems:"center", justifyContent:"center", color:"#999"}}>
            No header image uploaded
          </div>
        )}
      </div>

      <table style={{width:"100%", borderCollapse:"collapse", marginBottom:"20px", border:"2px solid #0000cc"}}>
        <tbody>
          <tr>
            <td style={{background:"#0000cc", color:"#fff", fontWeight:"bold", padding:"6px 10px", width:"30%"}}>Title</td>
            <td style={{padding:"6px 10px", border:"1px solid #0000cc"}} colSpan="3">{renderEditable("title", data.title)}</td>
          </tr>
          <tr>
            <td style={{background:"#0000cc", color:"#fff", fontWeight:"bold", padding:"6px 10px"}}>Date and Time</td>
            <td style={{padding:"6px 10px", border:"1px solid #0000cc", fontWeight:"bold"}} colSpan="3">{renderEditable("dateTime", data.dateTime)}</td>
          </tr>
          <tr>
            <td style={{background:"#0000cc", color:"#fff", fontWeight:"bold", padding:"6px 10px"}}>Mode/Platform/Location</td>
            <td style={{padding:"6px 10px", border:"1px solid #0000cc"}}>{renderEditable("mode", data.mode)}</td>
            <td style={{background:"#0000cc", color:"#fff", fontWeight:"bold", padding:"6px 10px"}}>Control No.</td>
            <td style={{padding:"6px 10px", border:"1px solid #0000cc"}}>{renderEditable("controlNo", data.controlNo)}</td>
          </tr>
          <tr>
            <td style={{background:"#0000cc", color:"#fff", fontWeight:"bold", padding:"6px 10px"}}>Participants</td>
            <td style={{padding:"6px 10px", border:"1px solid #0000cc", color:"#0000cc", textDecoration:"underline"}} colSpan="3">Attached Attendance</td>
          </tr>
        </tbody>
      </table>

      <div style={{marginBottom:"20px"}}>
        <div style={{fontWeight:"bold", marginBottom:"8px"}}>I.&nbsp;&nbsp;&nbsp;RATIONALE</div>
        {data.rationale.split("\n").filter(p=>p.trim()).map((p,i) => (
          <p key={i} style={{textAlign:"justify", textIndent:"36px", marginBottom:"8px", lineHeight:"1.8"}}>{renderEditable("rationale", p)}</p>
        ))}
      </div>

      <div style={{marginBottom:"20px"}}>
        <div style={{fontWeight:"bold", marginBottom:"8px"}}>II.&nbsp;&nbsp;ATTENDEES</div>
        <div style={{fontWeight:"bold", fontStyle:"italic", marginBottom:"6px", paddingLeft:"24px"}}>A. Facilitator (DICT)</div>
        <table style={{width:"100%", borderCollapse:"collapse", marginBottom:"8px"}}>
          <thead>
            <tr>
              {["Name","Office","Gender"].map(h => (
                <th key={h} style={{background:"#0000cc", color:"#fff", padding:"6px 10px", border:"1px solid #0000cc"}}>{h}</th>
              ))}
              {onRemoveFacilitator && <th style={{background:"#0000cc", color:"#fff", padding:"6px 4px", border:"1px solid #0000cc", width:"28px"}}></th>}
            </tr>
          </thead>
          <tbody>
            {data.facilitators.map((f,i) => (
              <tr key={i}>
                <td style={{padding:"5px 10px", border:"1px solid #ccc"}}>{renderEditable(`facilitators.${i}.name`, f.name, `facilitators.${i}.name`)}</td>
                <td style={{padding:"5px 10px", border:"1px solid #ccc"}}>{renderEditable(`facilitators.${i}.office`, f.office, `facilitators.${i}.office`)}</td>
                <td style={{padding:"4px 6px", border:"1px solid #ccc", textAlign:"center"}}>
                  {onUpdate ? (
                    /* Dropdown keeps the stored value M/F so tallies stay exact;
                       countGenders still tolerates legacy free-text values. */
                    <select
                      value={["M", "F"].includes(String(f.gender || "").trim().toUpperCase()) ? String(f.gender).trim().toUpperCase() : ""}
                      onChange={e => onUpdate(`facilitators.${i}.gender`, e.target.value)}
                      style={{width:"100%", maxWidth:"56px", border:"1px solid #ccd5f0", borderRadius:"4px", fontSize:"12px", padding:"3px 2px", background:"#fff"}}
                    >
                      <option value="">—</option>
                      <option value="M">M</option>
                      <option value="F">F</option>
                    </select>
                  ) : f.gender}
                </td>
                {onRemoveFacilitator && (
                  <td style={{padding:"2px 4px", border:"1px solid #ccc", textAlign:"center"}}>
                    <button onClick={() => onRemoveFacilitator(i)} title="Remove facilitator" style={{border:"none", background:"transparent", color:"#cc0000", cursor:"pointer", fontWeight:"bold"}}>✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {onAddFacilitator && (
          <div style={{marginBottom:"8px"}}>
            <button onClick={onAddFacilitator} style={{padding:"4px 12px", borderRadius:"14px", border:"1px solid #0000cc", background:"#fff", color:"#0000cc", fontSize:"11px", fontWeight:"600", cursor:"pointer"}}>+ Add Facilitator</button>
          </div>
        )}
        <div style={{textAlign:"right", fontWeight:"bold", marginBottom:"16px"}}>Male: {facilitatorMale} | Female: {facilitatorFemale}</div>

        {benField && (
          <>
            <div style={{fontWeight:"bold", fontStyle:"italic", marginBottom:"6px", paddingLeft:"24px"}}>B. {benField.sectionTitle || `${cats.map(c => c.label).join(" / ")} and other Beneficiaries`} <span style={{fontStyle:"italic", fontWeight:"normal"}}>(please see attached attendance sheet)</span></div>
            <table style={{width:"100%", borderCollapse:"collapse", marginBottom:"8px"}}>
              <thead>
                <tr>
                  {cats.map(c => (
                    <th key={c.id} colSpan="2" style={{background:"#0000cc", color:"#fff", padding:"6px", border:"1px solid #0000cc"}}>{c.label}</th>
                  ))}
                </tr>
                <tr>
                  {cats.flatMap(c => ["Male","Female"]).map((g,i) => (
                    <th key={i} style={{background:"#eef", padding:"5px 6px", border:"1px solid #ccc", fontWeight:"normal"}}>{g}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {cats.flatMap(c => ["male","female"].map(g => [c, g])).map(([c, g], i) => (
                    <td key={i} style={{padding:"2px 4px", border:"1px solid #ccc", textAlign:"center"}}>
                      {onUpdate
                        ? renderEditable(`beneficiaries.${c.id}.${g}`, String(b?.[c.id]?.[g] ?? ""), `beneficiaries.${c.id}.${g}`)
                        : (b?.[c.id]?.[g] || "")}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <div style={{textAlign:"right", fontWeight:"bold", marginBottom:"16px"}}>Male: {benMale} | Female: {benFemale}</div>
          </>
        )}

        <div style={{fontWeight:"bold", fontStyle:"italic", marginBottom:"6px", paddingLeft:"24px"}}>C. Consolidated participants</div>
        <table style={{width:"60%", borderCollapse:"collapse"}}>
          <tbody>
            <tr><td style={{padding:"5px 10px", border:"1px solid #ccc"}}>Total number of male attendees</td><td style={{padding:"5px 20px", border:"1px solid #ccc", textAlign:"center"}}>{totalMale}</td></tr>
            <tr><td style={{padding:"5px 10px", border:"1px solid #ccc"}}>Total number of female attendees</td><td style={{padding:"5px 20px", border:"1px solid #ccc", textAlign:"center"}}>{totalFemale}</td></tr>
            <tr><td style={{padding:"6px 10px", border:"1px solid #0000cc", background:"#0000cc", color:"#fff", fontWeight:"bold"}}>Total number of attendees</td><td style={{padding:"6px 20px", border:"1px solid #0000cc", background:"#0000cc", color:"#fff", fontWeight:"bold", textAlign:"center"}}>{totalMale+totalFemale}</td></tr>
          </tbody>
        </table>
      </div>

      <div style={{marginBottom:"20px"}}>
        <div style={{fontWeight:"bold", marginBottom:"8px"}}>III.&nbsp;HIGHLIGHTS OF DISCUSSION</div>
        {data.highlights.split("\n").filter(p=>p.trim()).map((p,i) => (
          <p key={i} style={{textAlign:"justify", textIndent:"36px", marginBottom:"8px", lineHeight:"1.8", paddingLeft:"24px"}}>{renderEditable("highlights", p)}</p>
        ))}
        <div style={{textAlign:"center", fontStyle:"italic", marginTop:"12px", fontSize:"9pt"}}>
          [{data.title} on {data.dateTime?.split("|")[0]?.trim()}]
        </div>
      </div>

      <div style={{marginBottom:"20px"}}>
        <div style={{fontWeight:"bold", marginBottom:"8px", display:"flex", alignItems:"center", gap:"12px"}}>
          <span>IV.&nbsp;&nbsp;ANNEXES</span>
          {photos.length > 0 && onLayoutChange && (
            <select value={photoLayout} onChange={e => onLayoutChange(e.target.value)} style={{
              fontSize:"12px", padding:"3px 8px", borderRadius:"6px", border:"1px solid #ccd5f0", fontWeight:"normal"
            }} title="Photo collage layout">
              {COLLAGE_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          )}
        </div>
        <div style={{fontWeight:"bold", fontStyle:"italic", marginBottom:"12px", paddingLeft:"24px"}}>A. PHOTOS <span style={{fontStyle:"italic", fontWeight:"normal"}}>(must be action picture)</span></div>
            {photos.length > 0 ? (
              <div style={{...collageGridStyle(photoLayout), borderWidth:"2px", gap:"4px", padding:"4px"}}>
                {photos.map((p, i) => {
                  const slot = collageSlotStyle(photoLayout, i);
                  return (
                    <div key={i} style={{...slot, overflow:"hidden", background:"#f5f5f5", position:"relative"}}>
                      <PhotoSlot src={p} index={i} onRemove={onRemovePhoto}/>
                    </div>
                  );
                })}
              </div>
            ) : (
          <div style={{border:"2px dashed #aaa", padding:"40px", textAlign:"center", color:"#999", margin:"0 0 16px 24px"}}>Upload photos using the button above</div>
        )}
      </div>

      {personIds.size > 0 && (
        <table style={{width:"100%", borderCollapse:"collapse", border:"1px solid #ccc"}}>
          <tbody>
            <tr>
              {personIds.has("preparedBy") && (
                <td style={{padding:"12px 16px", border:"1px solid #ccc", width:"50%", verticalAlign:"top"}}>
                  <div style={{fontWeight:"bold", marginBottom:"8px"}}>Prepared by:</div>
                  <PersonPicker id="preparedBy" data={data.preparedBy} personnel={template.personnel} onUpdate={onUpdate}/>
                </td>
              )}
              {personIds.has("conformedBy") && (
                <td style={{padding:"12px 16px", border:"1px solid #ccc", verticalAlign:"top"}}>
                  <div style={{fontWeight:"bold", marginBottom:"8px"}}>Conformed by:</div>
                  <PersonPicker id="conformedBy" data={data.conformedBy} personnel={template.personnel} onUpdate={onUpdate}/>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      )}
      <div style={{marginTop:"8px", fontStyle:"italic", color:"#0000cc", fontSize:"10pt"}}>Copy furnish: eLGU Project Management Team</div>

      <div style={{marginTop:"20px", overflow:"hidden"}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:"9pt", marginBottom:"6px"}}>
          <div style={{fontStyle:"italic"}}>[{data.title} on {data.dateTime?.split("|")[0]?.trim()}]</div>
          <div className="page-number-display" style={{fontWeight:"bold", color:"#0000cc"}}>PAGE 1 OF 1</div>
        </div>
        {footerImg ? (
          <img src={footerImg} alt="footer" style={{width:"100%", display:"block", marginTop:"4px"}}/>
        ) : (
          <div style={{height:"60px", border:"2px dashed #ccc", display:"flex", alignItems:"center", justifyContent:"center", color:"#999", marginTop:"4px"}}>
            No footer image uploaded
          </div>
        )}
      </div>
    </div>
  );
}
