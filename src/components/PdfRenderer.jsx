import { FOOTER_IMG } from "../lib/assets.js";
import { normalizeReport, countGenders } from "../lib/report.js";
import { MAX_PHOTOS, collageGridStyle, collageSlotStyle } from "../lib/collage.js";

// PDF + RTF export rendering, extracted verbatim from the original app.

export const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

export const buildFooterLabel = (data, template) => {
  if (template?.layout === "egov") {
    return `Post-Event Report${data.eventName ? ` | ${escapeHtml(data.eventName)}` : ""}`;
  }
  if (template?.layout === "ilcdb") {
    return `After Activity Report${data.courseTitle ? ` | ${escapeHtml(data.courseTitle)}` : ""}`;
  }
  const title = data.title || "";
  const date = (data.dateTime || "").split("|")[0]?.trim() || "";
  return `[${escapeHtml(title)} on ${escapeHtml(date)}]`;
};

// Shared helpers for template-driven rendering.
const beneficiaryFieldOf = (template) =>
  (template?.fields || []).find(f => f.type === "beneficiaries");

const personIds = (template) =>
  new Set((template?.fields || []).filter(f => f.type === "person").map(f => f.id));

// -------------------------------------------------------------------------
// eGov PH Post-Event Report (layout: "egov") — PDF blocks. Emits the same
// block vocabulary as the classic builder so the A4 pagination engine
// (measure → fit → split tables/photo-grids across pages) works unchanged.
// -------------------------------------------------------------------------
const buildEgovPdfBlocks = (data, photos, headerImgData, template, photoLayout = "classic") => {
  const fieldOf = (id) => (template?.fields || []).find(f => f.id === id);
  const cell = value => escapeHtml(value || "");
  const img = src => src ? escapeHtml(src) : "";
  const paras = value => String(value || "")
    .split(/\n+/).map(s => s.trim()).filter(Boolean);
  const styleAttr = (obj) => Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}:${v}`).join(";");
  const blocks = [];

  if (headerImgData) {
    blocks.push(`<img class="pdf-header-img" src="${img(headerImgData)}" alt="header">`);
  }

  blocks.push(`<div style="text-align:center;font-weight:bold;font-size:14pt;letter-spacing:1px;margin:2mm 0 4mm">POST-EVENT REPORT</div>`);

  const reps = (data.representatives || []).map(r => (r?.name || "").trim()).filter(Boolean);
  blocks.push(`<table class="info-table"><tbody>
    <tr><th>Name of Event</th><td colspan="3">${cell(data.eventName)}</td></tr>
    <tr><th>Date/Time</th><td colspan="3"><strong>${cell(data.dateTime)}</strong></td></tr>
    <tr><th>Location</th><td colspan="3">${cell(data.location)}</td></tr>
    <tr><th>Time of Arrival</th><td>${cell(data.timeOfArrival)}</td><th>Estimated No. of Participants</th><td>${cell(data.estimatedParticipants)}</td></tr>
    <tr><th>Representative/s</th><td>${reps.map((r, i) => `${i + 1}. ${cell(r)}`).join("<br>")}</td><th>Total No. of Registrants</th><td>${cell(data.totalRegistrants)}</td></tr>
    <tr><th>Submitted Video and Photo Documentations?</th><td colspan="3">${data.docsSubmitted === "Yes" ? "● Yes &nbsp;&nbsp; ○ No" : data.docsSubmitted === "No" ? "○ Yes &nbsp;&nbsp; ● No" : ""}</td></tr>
  </tbody></table>`);

  blocks.push(`<h2>I. <span>OVERVIEW</span></h2>`);
  paras(data.overview).forEach(par => blocks.push(`<div class="para"><p>${cell(par)}</p></div>`));

  blocks.push(`<h2>II. <span>CHALLENGES &amp; RECOMMENDATION</span></h2>`);
  const chRows = (data.challenges || []).map(c =>
    `<tr><td>${cell(c?.issue)}</td><td>${cell(c?.recommendation)}</td></tr>`
  ).join("");
  blocks.push(`<table class="blue-table egov-challenges"><thead>
    <tr><th style="width:50%">Issues/Concerns/Problems Encountered</th><th>Proposed Recommendations</th></tr>
  </thead><tbody>${chRows}</tbody></table>`);

  blocks.push(`<h2>III. <span>PHOTO DOCUMENTATION</span></h2>`);
  const caps = Array.isArray(data.photoCaptions) ? data.photoCaptions : [];
  // Captions live inside each slot so they travel with the photo when the
  // engine splits the grid across pages.
  const gridHtml = `<div class="photo-grid" style="${styleAttr(collageGridStyle(photoLayout))}">` +
    photos.map((src, i) => {
      const slot = collageSlotStyle(photoLayout, i);
      return `<div class="photo-slot" style="${styleAttr({ ...slot, display: "flex", flexDirection: "column" })}">` +
        `<div style="flex:1 1 auto;overflow:hidden;min-height:0"><img style="width:100%;height:100%;object-fit:cover;display:block" src="${img(src)}" alt="Photo ${i + 1}"></div>` +
        `<div style="flex:0 0 auto;font-size:8pt;font-style:italic;text-align:center;padding-top:1mm">${cell(caps[i] || "")}</div>` +
        `</div>`;
    }).join("") +
    `</div>`;
  blocks.push(`<div class="keep">${gridHtml}</div>`);

  const mf = fieldOf("materials");
  if (mf) {
    blocks.push(`<h2>IV. <span>eGOVPH MATERIAL CONDITION</span></h2>`);
    const scales = mf.scales || [];
    const opts = mf.options || [];
    const head =
      `<tr><th rowspan="3" style="vertical-align:middle">Materials</th>` +
      `<th colspan="${scales.length * opts.length}">Condition Level</th></tr>` +
      `<tr>${scales.map(s => `<th colspan="${opts.length}">${escapeHtml(s.label)}</th>`).join("")}</tr>` +
      `<tr>${scales.flatMap(() => opts.map(o => `<th>${escapeHtml(o.label)}</th>`)).join("")}</tr>`;
    const rows = (mf.rows || []).map(r => {
      const cells = scales.flatMap(s => opts.map(o => {
        const sel = data.materials?.[r.id]?.[s.id] === o.id;
        return `<td class="center">${sel ? "●" : ""}</td>`;
      })).join("");
      return `<tr><td><strong>${escapeHtml(r.label)}</strong></td>${cells}</tr>`;
    }).join("");
    blocks.push(`<div class="keep">
      <table class="blue-table egov-matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>
      ${mf.note ? `<div class="para caption"><p>Note: ${cell(mf.note)}</p></div>` : ""}
      ${(mf.legend || []).length ? `<div class="para legend">${mf.legend.map(l => `<p>${cell(l)}</p>`).join("")}</div>` : ""}
    </div>`);
  }

  const labels = { preparedBy: "Prepared by:", reviewedBy: "Reviewed by:", approvedBy: "Approved by:" };
  const sigIds = ["preparedBy", "reviewedBy", "approvedBy"]
    .filter(id => (template?.fields || []).some(f => f.id === id && f.type === "person"));
  if (sigIds.length) {
    const sigCells = sigIds.map(id =>
      `<td><strong>${labels[id]}</strong><div class="signature-name">${cell(data[id]?.name)}</div><div>${cell(data[id]?.position)}</div></td>`
    ).join("");
    blocks.push(`<table class="signature-table"><tbody><tr>${sigCells}</tr></tbody></table>`);
  }

  return blocks;
};

// -------------------------------------------------------------------------
// ILCDB After Activity Report (layout: "ilcdb") — PDF blocks. Mirrors the
// official DICT Region II form: one black-bordered Training Details table
// whose first row is the section heading (incl. sex-disaggregated attendance
// and issued certificates), boxed II. Rationale / III. Objectives, V. Issues
// & VI. Recommendation side-by-side, boxed VII. Plans, VIII. Photo
// Documentation with day captions, and left-aligned signatories.
// -------------------------------------------------------------------------
const buildIlcdbPdfBlocks = (data, photos, headerImgData, template, photoLayout = "classic") => {
  const cell = value => escapeHtml(value || "");
  const img = src => src ? escapeHtml(src) : "";
  const paras = value => String(value || "")
    .split(/\n+/).map(s => s.trim()).filter(Boolean);
  const styleAttr = (obj) => Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}:${v}`).join(";");
  const blocks = [];

  const b = data.beneficiaries || {};
  const benField = beneficiaryFieldOf(template);
  const cats = (benField && benField.categories) || [];
  const num = value => Number(value || 0);
  const cap = (c, g) => num(b[c.id]?.[g]);
  const totalMale = cats.reduce((s, c) => s + cap(c, "male"), 0);
  const totalFemale = cats.reduce((s, c) => s + cap(c, "female"), 0);

  // Objective bullets: skip any model-generated duplicate of the intro line.
  const objectiveLines = paras(data.objectives)
    .filter(l => !/^\s*upon\s+completion\s+of\s+the\s+course/i.test(l))
    .map(l => l.replace(/^[•●]\s*/, "").trim())
    .filter(Boolean);

  if (headerImgData) {
    blocks.push(`<img class="pdf-header-img" src="${img(headerImgData)}" alt="header">`);
  }

  blocks.push(`<div style="text-align:center;font-weight:bold;font-size:14pt;letter-spacing:1px;margin:2mm 0 4mm">AFTER ACTIVITY REPORT</div>`);

  const box = (head, bodyHtml) => `<div class="blk ilcdb-box">
    <div class="ilcdb-box-head">${head}</div>
    <div class="ilcdb-box-body">${bodyHtml}</div>
  </div>`;
  const para = text => `<div class="para"><p>${cell(text)}</p></div>`;
  const bullet = text => `<div class="para"><p>&bull; ${cell(text)}</p></div>`;

  // I. TRAINING DETAILS — one black-bordered table, heading as first row.
  const td = (content, extra = "") => `<td${extra}>${content}</td>`;
  const lbl = text => `<td style="width:25%"><strong>${text}</strong></td>`;
  const training = `<table class="ilcdb-table"><thead>
    <tr><th colspan="4" style="text-align:left">I.&nbsp;&nbsp;&nbsp;TRAINING DETAILS</th></tr>
  </thead><tbody>
    <tr>${lbl("Course Title:")}${td(`<strong>${cell(data.courseTitle)}</strong>`, ' colspan="3"')}</tr>
    <tr>${lbl("Course Code:")}${td(cell(data.courseCode), ' colspan="3"')}</tr>
    <tr>${lbl("Date:")}${td(cell(data.dateTime))}${lbl("Time:")}${td(cell(data.time))}</tr>
    <tr>${lbl("Duration:")}${td(cell(data.duration), ' colspan="3"')}</tr>
    <tr>${lbl("Venue:")}${td(cell(data.venue), ' colspan="3"')}</tr>
    <tr>${lbl("Course Officer:")}${td(cell(data.courseOfficer), ' colspan="3"')}</tr>
    <tr>${lbl("Admin Assistant:")}${td(cell(data.adminAssistant), ' colspan="3"')}</tr>
    <tr>${lbl("Technical Support:")}${td(cell(data.technicalSupport), ' colspan="3"')}</tr>
    <tr>${lbl("Resource Person:")}${td(cell(data.resourcePerson), ' colspan="3"')}</tr>
    <tr>${lbl("Platform Used:")}${td(cell(data.platformUsed))}${lbl("Mode:")}${td(cell(data.mode))}</tr>
    <tr>${lbl("Target Participants:")}${td(cell(data.targetParticipants), ' colspan="3"')}</tr>
    <tr>${td("<strong>Total # of Attendees:</strong><br><small>(with/without submitted Evaluation Form/Output)</small>")}${td(`<strong>${totalMale + totalFemale}</strong>`, ' style="text-align:center"')}${td(`Male<br><strong>${totalMale}</strong>`, ' style="text-align:center"')}${td(`Female<br><strong>${totalFemale}</strong>`, ' style="text-align:center"')}</tr>
    <tr>${td("Number of Beneficiary/ies with Sex Disaggregation", ' colspan="4" style="text-align:center;font-weight:bold"')}</tr>
    <tr>${td("<strong>Sector Category</strong>")}${td("<strong>Total</strong>", ' style="text-align:center"')}${td("<strong>Male</strong>", ' style="text-align:center"')}${td("<strong>Female</strong>", ' style="text-align:center"')}</tr>
    ${cats.map(c => `<tr>${td(`<strong>${escapeHtml(c.label)}</strong>`)}${td(`<strong>${cap(c, "male") + cap(c, "female")}</strong>`, ' style="text-align:center"')}${td(cap(c, "male") || "", ' style="text-align:center"')}${td(cap(c, "female") || "", ' style="text-align:center"')}</tr>`).join("")}
    <tr>${td(`<strong>Total # of Issued Certificates:</strong><br><small>(with submitted Evaluation Form/Output)</small>`)}${td(cell(data.certificatesIssued), ' colspan="3"')}</tr>
  </tbody></table>`;
  blocks.push(training);

  // II. RATIONALE — boxed.
  blocks.push(box("II.&nbsp;&nbsp;&nbsp;RATIONALE", paras(data.rationale).map(para).join("")));

  // III. OBJECTIVES — static intro line + bullets + Topics Covered.
  const objHtml = `<div style="font-style:italic;margin-bottom:2mm">Upon completion of the course, participants will be able to learn:</div>` +
    (objectiveLines.length ? objectiveLines.map(bullet).join("") : `<div class="para"><p>&nbsp;</p></div>`) +
    (String(data.topicsCovered || "").trim() ? `<div style="font-weight:bold;margin-top:3mm;margin-bottom:1mm">Topics Covered:</div>` + paras(data.topicsCovered).map(para).join("") : "");
  blocks.push(box("III.&nbsp;&nbsp;&nbsp;OBJECTIVES", objHtml));

  // V. ISSUES AND CONCERNS | VI. RECOMMENDATION — side by side.
  const issueHtml = (data.issues || []).filter(it => String(it?.issue || "").trim()).map(it => bullet(it.issue)).join("");
  const recHtml = (data.recommendations || []).filter(it => String(it?.recommendation || "").trim()).map(it => bullet(it.recommendation)).join("");
  blocks.push(`<div class="blk ilcdb-box" style="display:flow-root">
    <table class="ilcdb-two"><tbody><tr>
      <td style="width:50%;vertical-align:top;border-right:1px solid #000">
        <div class="ilcdb-box-head">V.&nbsp;&nbsp;&nbsp;ISSUES AND CONCERNS</div>
        <div class="ilcdb-box-body">${issueHtml}</div>
      </td>
      <td style="width:50%;vertical-align:top">
        <div class="ilcdb-box-head">VI.&nbsp;&nbsp;&nbsp;RECOMMENDATION</div>
        <div class="ilcdb-box-body">${recHtml}</div>
      </td>
    </tr></tbody></table>
  </div>`);

  // VII. PLANS AND ACTION ITEMS (NEXT STEPS) — boxed.
  blocks.push(box("VII.&nbsp;&nbsp;PLANS AND ACTION ITEMS (NEXT STEPS)", paras(data.plansActions).map(bullet).join("")));

  // VIII. PHOTO DOCUMENTATION — day captions above each photo.
  const gridHtml = `<div class="photo-grid" style="${styleAttr(collageGridStyle(photoLayout))}">` +
    photos.map((src, i) => {
      const caption = (Array.isArray(data.photoCaptions) ? data.photoCaptions[i] : "") || "";
      return `<div class="photo-slot" style="${styleAttr(collageSlotStyle(photoLayout, i))}">` +
        `<div style="text-align:center;font-weight:bold;font-size:8.5pt;padding:1mm 0">${cell(caption)}</div>` +
        `<img src="${img(src)}" alt="Photo ${i + 1}">` +
        `</div>`;
    }).join("") +
    `</div>`;
  blocks.push(box("VIII.&nbsp;&nbsp;PHOTO DOCUMENTATION", gridHtml));

  // Signatories — left aligned (bold name, italic position).
  const persons = personIds(template);
  const sigIds = ["preparedBy", "notedBy"].filter(id => persons.has(id));
  if (sigIds.length) {
    const labels = { preparedBy: "Prepared by:", notedBy: "Noted by:" };
    const sigHtml = `<table style="width:100%;border:none"><tbody><tr>` +
      sigIds.map(id => `<td style="width:50%;border:none;vertical-align:top;padding:2mm 0">
        <div>${labels[id]}</div>
        <div style="font-weight:bold;text-transform:uppercase;margin-top:2mm">${cell(data[id]?.name)}</div>
        <div style="font-style:italic">${cell(data[id]?.position)}</div>
      </td>`).join("") +
      `</tr></tbody></table>`;
    blocks.push(`<div class="blk ilcdb-sign">${sigHtml}</div>`);
  }

  return blocks;
};

export const buildPdfBlocks = (data, photos, headerImgData, template, photoLayout = "classic") => {
  if (template?.layout === "egov") {
    return buildEgovPdfBlocks(data, photos, headerImgData, template, photoLayout);
  }
  if (template?.layout === "ilcdb") {
    return buildIlcdbPdfBlocks(data, photos, headerImgData, template, photoLayout);
  }
  const benField = beneficiaryFieldOf(template);
  const cats = benField?.categories || [];
  const persons = personIds(template);
  const hasPersons = persons.size > 0;
  const b = data.beneficiaries || {};
  const { male: facilitatorMale, female: facilitatorFemale } = countGenders(data.facilitators);
  const sumCat = (g) => cats.reduce((s, c) => s + (Number(b[c.id]?.[g]) || 0), 0);
  const benMale = sumCat("male");
  const benFemale = sumCat("female");
  const totalMale = facilitatorMale + benMale;
  const totalFemale = facilitatorFemale + benFemale;
  const cell = value => escapeHtml(value || "");
  const num = value => Number(value || 0);
  const img = src => src ? escapeHtml(src) : "";
  const paras = value => String(value || "")
    .split(/\n+/).map(s => s.trim()).filter(Boolean);
  const blocks = [];

  if (headerImgData) {
    blocks.push(`<img class="pdf-header-img" src="${img(headerImgData)}" alt="header">`);
  }

  blocks.push(`<table class="info-table"><tbody>
    <tr><th>Title</th><td colspan="3">${cell(data.title)}</td></tr>
    <tr><th>Date and Time</th><td colspan="3"><strong>${cell(data.dateTime)}</strong></td></tr>
    <tr><th>Mode/Platform/Location</th><td>${cell(data.mode)}</td><th>Control No.</th><td>${cell(data.controlNo)}</td></tr>
    <tr><th>Participants</th><td colspan="3" class="linkish">Attached Attendance</td></tr>
  </tbody></table>`);

  blocks.push(`<h2>I. <span>RATIONALE</span></h2>`);
  paras(data.rationale).forEach(par => blocks.push(`<div class="para"><p>${cell(par)}</p></div>`));

  blocks.push(`<h2>II. <span>ATTENDEES</span></h2>`);

  const facilitatorRows = data.facilitators.map(f => `
    <tr><td>${cell(f.name)}</td><td>${cell(f.office)}</td><td class="center">${cell(f.gender)}</td></tr>
  `).join("");
  blocks.push(`<div class="keep">
    <h3>A. Facilitator (DICT)</h3>
    <table class="blue-table facilitator-table">
      <thead><tr><th>Name</th><th>Office</th><th>Gender</th></tr></thead>
      <tbody>${facilitatorRows}</tbody>
    </table>
    <div class="totals-line">Male: ${facilitatorMale} | Female: ${facilitatorFemale}</div>
  </div>`);

  if (benField) {
    const sectionTitle = benField.sectionTitle ||
      `${cats.map(c => c.label).join(" / ")} and other Beneficiaries`;
    blocks.push(`<div class="keep">
      <h3>B. ${escapeHtml(sectionTitle)} <em>(please see attached attendance sheet)</em></h3>
      <table class="blue-table beneficiary-table">
        <thead>
          <tr>${cats.map(c => `<th colspan="2">${escapeHtml(c.label)}</th>`).join("")}</tr>
          <tr class="subhead">${cats.map(() => "<td>Male</td><td>Female</td>").join("")}</tr>
        </thead>
        <tbody>
          <tr>
            ${cats.map(c => `<td>${num(b[c.id]?.male) || ""}</td><td>${num(b[c.id]?.female) || ""}</td>`).join("")}
          </tr>
        </tbody>
      </table>
      <div class="totals-line">Male: ${benMale} | Female: ${benFemale}</div>
    </div>`);
  }

  blocks.push(`<div class="keep">
    <h3>C. Consolidated participants</h3>
    <table class="summary-table"><tbody>
      <tr><td>Total number of male attendees</td><td>${totalMale}</td></tr>
      <tr><td>Total number of female attendees</td><td>${totalFemale}</td></tr>
      <tr class="summary-total"><td>Total number of attendees</td><td>${totalMale + totalFemale}</td></tr>
    </tbody></table>
  </div>`);

  blocks.push(`<h2>III. <span>HIGHLIGHTS OF DISCUSSION</span></h2>`);
  paras(data.highlights).forEach(par => blocks.push(`<div class="para"><p>${cell(par)}</p></div>`));
  blocks.push(`<div class="para caption"><p>[${cell(data.title)} on ${cell((data.dateTime || "").split("|")[0]?.trim() || "")}]</p></div>`);

  blocks.push(`<h2>IV. <span>ANNEXES</span></h2>`);
  const styleAttr = (obj) => Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}:${v}`).join(";");
  // Collage layout (see src/lib/collage.js): slots are rendered with inline
  // styles so the print-window measure() pass sees exact sizes.
  const gridHtml = `<div class="photo-grid" style="${styleAttr(collageGridStyle(photoLayout))}">` +
    photos.map((src, i) =>
      `<div class="photo-slot" style="${styleAttr(collageSlotStyle(photoLayout, i))}"><img src="${img(src)}" alt="Photo ${i + 1}"></div>`
    ).join("") +
    `</div>`;
  blocks.push(`<div class="keep">
    <h3>A. PHOTOS <em>(must be action picture)</em></h3>
    ${gridHtml}
  </div>`);

  if (hasPersons) {
    const sigCells = [
      persons.has("preparedBy") ? `<td><strong>Prepared by:</strong><div class="signature-name">${cell(data.preparedBy?.name)}</div><div>${cell(data.preparedBy?.position)}</div></td>` : "",
      persons.has("conformedBy") ? `<td><strong>Conformed by:</strong><div class="signature-name">${cell(data.conformedBy?.name)}</div><div>${cell(data.conformedBy?.position)}</div></td>` : ""
    ].filter(Boolean).join("");
    blocks.push(`<table class="signature-table"><tbody><tr>${sigCells}</tr></tbody></table>`);
  }

  blocks.push(`<div class="copy-furnish">Copy furnish: eLGU Project Management Team</div>`);

  return blocks;
};

// Opens a print window with dynamically paginated content blocks so the page
// numbers ("PAGE X OF N") always match the actual printed pages.
export const printReport = ({ data, photos, headerImgData, footerImgData, template, photoLayout = "classic" }) => {
  const w = window.open("", "_blank");
  if (!w) return;

  photos = photos.slice(0, MAX_PHOTOS);
  data = normalizeReport(data, template);
  const blocks = buildPdfBlocks(data, photos, headerImgData, template, photoLayout);
  const footerLabel = buildFooterLabel(data, template);
  const preloads = [headerImgData, footerImgData, FOOTER_IMG, ...photos.slice(0, MAX_PHOTOS)]
    .filter(Boolean)
    .map(src => `<img src="${escapeHtml(src)}" alt="" style="display:none">`)
    .join("");
  const payload = JSON.stringify({ blocks, footerLabel, footerImg: footerImgData || "" })
    .replace(/<\//g, "<\\/");

  const baseHref = document.baseURI;
  w.document.write(`<!DOCTYPE html><html><head><title>AAR Report</title>
  <base href="${baseHref}">
  <style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 0; }
    html, body { margin: 0; padding: 0; font-family: 'Times New Roman', serif; font-size: 11pt; color: #000; background: #fff; }
    .pdf-page { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #fff; page-break-after: always; break-after: page; }
    .pdf-page:last-child { page-break-after: auto; break-after: auto; }
    .top-pattern { position: absolute; top: 0; left: 0; width: 100%; height: 7mm; background-image: url("${FOOTER_IMG}"); background-size: 210mm auto; background-position: left bottom; background-repeat: no-repeat; }
    .pdf-content { position: absolute; left: 19mm; right: 19mm; bottom: 22mm; }
    .pdf-content.page-one { top: 13mm; }
    .pdf-content.continuation { top: 24mm; }
    /* Spacing system: .blk's padding-bottom (4mm) is the ONLY inter-block gap;
       inner margins stay out of the way so the rhythm never doubles up.
       Section headings add 4mm of their own above for hierarchy. */
    .blk { display: flow-root; padding-bottom: 4mm; }
    .pdf-header-img { display: block; width: 100%; margin: 0 auto; }
    table { border-collapse: collapse; width: 100%; }
    .info-table { border: 1.5px solid #0000cc; font-size: 10pt; }
    .info-table th { width: 31%; text-align: left; background: #0000cc; color: #fff; padding: 3px 7px; border: 1px solid #0000cc; font-weight: 700; }
    .info-table td { padding: 3px 7px; border: 1px solid #0000cc; vertical-align: middle; }
    .info-table .linkish { color: #0000cc; text-decoration: underline; }
    h2 { margin: 0; padding-top: 4mm; font-size: 11pt; font-weight: 700; }
    h2 span { margin-left: 8mm; }
    h3 { margin: 0 0 3mm 13mm; font-size: 10.5pt; font-style: italic; font-weight: 700; }
    h3 em { font-weight: 400; }
    .para { margin: 0; font-size: 10.5pt; line-height: 1.85; text-align: justify; }
    .para p { margin: 0; text-indent: 11mm; }
    .para.caption p { text-align: center; font-style: italic; font-size: 9pt; text-indent: 0; }
    .blue-table { margin: 0 0 0 18mm; width: calc(100% - 18mm); font-size: 10pt; }
    .blue-table th { background: #0000cc; color: #fff; border: 1px solid #0000cc; padding: 3px 6px; text-align: center; }
    .blue-table td { border: 1px solid #0000cc; padding: 3px 6px; }
    .center, .beneficiary-table td { text-align: center; }
    .beneficiary-table .subhead td { font-weight: 400; }
    .totals-line { text-align: right; font-weight: 700; margin: 2mm 0 0; font-size: 10pt; }
    .summary-table { margin: 0 0 0 18mm; width: calc(100% - 18mm); font-size: 10pt; }
    .summary-table td { border: 1px solid #0000cc; padding: 3px 6px; }
    .summary-table td:last-child { width: 34%; text-align: center; }
    .summary-total td { background: #0000cc; color: #fff; font-weight: 700; text-align: center; }
    .photo-grid { margin: 0; }
    .photo-slot { overflow: hidden; background: #f5f5f5; }
    .photo-slot img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .signature-table { border: 1px solid #0000cc; font-size: 10pt; }
    .signature-table td { width: 50%; height: 32mm; border: 1px solid #0000cc; padding: 5mm 7mm 3mm; vertical-align: top; }
    .signature-name { margin-top: 14mm; font-weight: 700; text-align: center; text-transform: uppercase; }
    .signature-name + div { text-align: center; text-transform: uppercase; font-size: 9.5pt; }
    .copy-furnish { color: #0000cc; font-style: italic; font-size: 10pt; }
    /* ILCDB After Activity Report — black-bordered form */
    .ilcdb-table { border: 1px solid #000; font-size: 10pt; }
    .ilcdb-table th { border: 1px solid #000; background: #fff; color: #000; padding: 3px 7px; text-align: center; }
    .ilcdb-table td { border: 1px solid #000; padding: 3px 7px; vertical-align: middle; }
    .ilcdb-box { border: 1px solid #000; font-size: 10.5pt; }
    .ilcdb-box-head { border-bottom: 1px solid #000; padding: 3px 9px; font-weight: 700; background: #fff; }
    .ilcdb-box-body { padding: 5px 9px; }
    .ilcdb-box-body .para p { text-indent: 6mm; }
    .ilcdb-two td { padding: 0; }
    .pdf-footer { position: absolute; left: 0; right: 0; bottom: 0; height: 22mm; }
    .pdf-footer-meta { position: absolute; left: 19mm; right: 19mm; bottom: 10mm; min-height: 7mm; font-size: 8.5pt; color: #0000cc; }
    .pdf-ref { position: absolute; left: 0; bottom: 3mm; max-width: 112mm; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-style: italic; font-weight: 700; }
    .pdf-page-no { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); color: #000; font-size: 8pt; }
    .pdf-footer-img { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; display: block; }
    @media print {
      body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      img { max-width: 100% !important; }
    }
  </style>
  </head><body>
  <div id="pdf-pages"></div>
  ${preloads}
  <script>
  (function(){
    "use strict";
    var __PAYLOAD__ = ${payload};

    // A4 pagination engine. Each block either fits the current page, starts a
    // fresh one, or — when taller than a whole page — splits across pages by
    // flowing table rows or photo slots with repeated headers. Nothing is
    // ever clipped: every chunk is measured before it is placed.
    var MM = 96 / 25.4;
    var PAGE_H = 297 * MM;
    var BOTTOM = 22 * MM;
    var TOP_FIRST = 13 * MM;
    var TOP_CONT = 24 * MM;
    var MIN_ORPHAN = 25 * MM; // a section heading needs at least this much content under it
    var MIN_CHUNK = 18 * MM;  // don't start a split chunk in a thin leftover strip

    var container = null;
    var pages = [];
    var cur = null;

    function newPage(isFirst) {
      var page = document.createElement("div");
      page.className = "pdf-page";
      if (isFirst) {
        var pattern = document.createElement("div");
        pattern.className = "top-pattern";
        page.appendChild(pattern);
      }
      var content = document.createElement("div");
      content.className = "pdf-content" + (isFirst ? " page-one" : " continuation");
      page.appendChild(content);
      container.appendChild(page);
      var top = isFirst ? TOP_FIRST : TOP_CONT;
      cur = { content: content, used: 0, height: PAGE_H - top - BOTTOM };
      pages.push(cur);
    }

    function measure(html) {
      var probe = document.createElement("div");
      probe.className = "blk";
      probe.style.cssText = "position:absolute;left:-9999px;top:0;width:172mm;visibility:hidden;";
      probe.innerHTML = html;
      document.body.appendChild(probe);
      var h = probe.offsetHeight;
      document.body.removeChild(probe);
      return h;
    }

    function append(html) {
      var div = document.createElement("div");
      div.className = "blk";
      div.innerHTML = html;
      cur.content.appendChild(div);
      cur.used += div.offsetHeight;
    }

    // Largest count in [0..max] whose rendered chunk fits avail.
    function fitCount(render, max, avail) {
      var lo = 0, hi = max, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (measure(render(mid)) <= avail) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    }

    // Splits an oversized block across pages. Returns false when the block
    // contains nothing divisible (caller then places it whole on its own page).
    function splitAcrossPages(html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var root = doc.body.firstElementChild;
      if (!root) return false;
      var heading = root.querySelector("h3");
      var totals = root.querySelector(".totals-line");
      var table = root.querySelector("table");
      var grid = root.querySelector(".photo-grid");

      var items, buildWith;
      if (table && table.tBodies.length && table.tBodies[0].rows.length >= 2) {
        items = Array.prototype.slice.call(table.tBodies[0].rows);
        buildWith = function(chunk, part, isFinal) {
          var c = root.cloneNode(false);
          if (heading) {
            var h = heading.cloneNode(true);
            if (part > 0) h.appendChild(document.createTextNode(" (continued)"));
            c.appendChild(h);
          }
          var t = table.cloneNode(false);
          var th = table.querySelector("thead");
          if (th) t.appendChild(th.cloneNode(true));
          var tb = document.createElement("tbody");
          for (var r = 0; r < chunk.length; r++) tb.appendChild(chunk[r]);
          t.appendChild(tb);
          c.appendChild(t);
          if (totals && isFinal) c.appendChild(totals.cloneNode(true));
          return c.outerHTML;
        };
      } else if (grid && grid.children.length >= 2) {
        items = Array.prototype.slice.call(grid.children);
        buildWith = function(chunk, part, isFinal) {
          var c = root.cloneNode(false);
          if (heading) {
            var h = heading.cloneNode(true);
            if (part > 0) h.appendChild(document.createTextNode(" (continued)"));
            c.appendChild(h);
          }
          var g = grid.cloneNode(false);
          for (var r = 0; r < chunk.length; r++) g.appendChild(chunk[r]);
          c.appendChild(g);
          return c.outerHTML;
        };
      } else {
        return false;
      }

      var total = items.length;
      var placed = 0;
      var part = 0;
      while (placed < total) {
        var remaining = total - placed;
        var justPaged = false;
        if (part > 0 && cur.height - cur.used < MIN_CHUNK) {
          newPage(false);
          justPaged = true;
        }
        var p = part;
        var renderN = function(n) {
          return buildWith(items.slice(placed, placed + n), p, n === remaining);
        };
        var count = fitCount(renderN, remaining, cur.height - cur.used);
        if (!count) {
          if (justPaged || cur.used === 0) {
            if (p === 0) return false; // even one item can't fit an empty page
            count = 1;                 // force progress on a fresh page
          } else {
            newPage(false);
            continue;
          }
        }
        append(buildWith(items.slice(placed, placed + count), p, count === remaining));
        placed += count;
        part++;
      }
      return true;
    }

    function run() {
      container = document.getElementById("pdf-pages");
      newPage(true);
      var blocks = __PAYLOAD__.blocks;
      for (var bi = 0; bi < blocks.length; bi++) {
        var html = blocks[bi];
        var h = measure(html);

        // Section headings must not be orphaned at the bottom of a page.
        if (/^<h2/.test(html)) {
          if (cur.used + h > cur.height) newPage(false);
          else {
            var withNext = h + (bi + 1 < blocks.length ? Math.min(measure(blocks[bi + 1]), MIN_ORPHAN) : 0);
            if (cur.used + withNext > cur.height) newPage(false);
          }
          append(html);
          continue;
        }

        if (cur.used + h <= cur.height) { append(html); continue; }
        if (h <= cur.height) { newPage(false); append(html); continue; }
        if (!splitAcrossPages(html)) { newPage(false); append(html); }
      }

      pages.forEach(function(p, i) {
        var footer = document.createElement("div");
        footer.className = "pdf-footer";
        footer.innerHTML =
          '<div class="pdf-footer-meta">' +
            '<div class="pdf-ref">' + __PAYLOAD__.footerLabel + '</div>' +
            '<div class="pdf-page-no">PAGE ' + (i + 1) + ' OF ' + pages.length + '</div>' +
          '</div>' +
          (__PAYLOAD__.footerImg ? '<img class="pdf-footer-img" src="' + __PAYLOAD__.footerImg + '" alt="footer">' : '');
        p.content.parentNode.appendChild(footer);
      });

      window.focus();
      window.print();
    }

    if (document.readyState === "complete") run();
    else window.addEventListener("load", run);
  })();
  <\/script>
  </body></html>`);
  w.document.close();
};

// -------------------------------------------------------------------------
// RTF export
// -------------------------------------------------------------------------

const rtfEscape = (s) => {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\n") out += "\\par ";
    else if (ch === "\t") out += "\\tab ";
    else if (code < 128) out += ch;
    else if (code < 256) out += "\\'" + code.toString(16).padStart(2, "0");
    else out += "\\u" + code + "?";
  }
  return out;
};

const rtfTable = (rows, colWidths) => {
  const widths = [];
  let cum = 0;
  for (const w of colWidths) {
    cum += Math.round(w);
    widths.push(cum);
  }
  let out = "";
  rows.forEach((row, ri) => {
    out += "\\trowd\\trgaph108\\trleft0";
    if (ri === 0) {
      widths.forEach(ww => { out += "\\clcbpat1\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx" + ww; });
    } else {
      widths.forEach(ww => { out += "\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx" + ww; });
    }
    row.forEach((txt, ci) => {
      out += ri === 0
        ? "\\intbl{\\b\\fs20\\cf2 " + rtfEscape(txt) + "}\\cell "
        : "\\intbl{" + rtfEscape(txt) + "}\\cell ";
    });
    out += "\\row\n";
  });
  return out;
};

const base64ToHex = (b64) => {
  const bin = atob(b64);
  let hex = "";
  for (let i = 0; i < bin.length; i++) {
    hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
};

const rtfPictures = (photos) => {
  let out = "";
  photos.slice(0, MAX_PHOTOS).forEach(p => {
    const m = String(p).match(/^data:image\/(\w+);base64,(.*)$/);
    if (!m) return;
    try {
      const hex = base64ToHex(m[2]);
      out += "\\par{\\pict\\jpegblip " + hex + "}\\par ";
    } catch { /* skip unreadable image */ }
  });
  return out;
};

// eGov PH Post-Event Report RTF — mirrors buildEgovPdfBlocks' sections in
// the shared RTF conventions (rtfTable/paras/rtfEscape) above.
const buildEgovRtf = (data, photos, template) => {
  const W = 9644; // usable text width in twips (17 cm)
  const RESET = "\\pard\\plain\\f0\\fs22 ";
  const paras = (s) => String(s || "")
    .split(/\n+/).map(x => x.trim()).filter(Boolean)
    .map(x => "\\pard\\fi567\\sl360 " + rtfEscape(x) + "\\par")
    .join("\n");

  let rtf = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n" +
    "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}\n" +
    "{\\colortbl;\\red0\\green0\\blue204;\\red255\\green255\\blue255;}\n" +
    "\\paperw11906\\paperh16838\n" +
    "\\margl1134\\margr1134\\margt1134\\margb1134\n" +
    RESET + "\n";

  rtf += RESET + "{\\b\\fs28 POST-EVENT REPORT}\\par\\par\n";
  rtf += RESET + "{\\b Name of Event:} " + rtfEscape(data.eventName || "") + "\\par\n";
  rtf += RESET + "{\\b Date/Time:} " + rtfEscape(data.dateTime || "") + "\\par\n";
  rtf += RESET + "{\\b Location:} " + rtfEscape(data.location || "") + "\\par\n";
  rtf += RESET + "{\\b Time of Arrival:} " + rtfEscape(data.timeOfArrival || "") + "\\par\n";
  rtf += RESET + "{\\b Estimated No. of Participants:} " + rtfEscape(data.estimatedParticipants || "") + "\\par\n";
  const reps = (data.representatives || []).map(r => (r?.name || "").trim()).filter(Boolean);
  rtf += RESET + "{\\b Representative/s:} " + (reps.length ? reps.map((r, i) => `${i + 1}. ${rtfEscape(r)}`).join("  ") : "") + "\\par\n";
  rtf += RESET + "{\\b Total No. of Registrants:} " + rtfEscape(data.totalRegistrants || "") + "\\par\n";
  rtf += RESET + "{\\b Submitted Video and Photo Documentations?:} " + rtfEscape(data.docsSubmitted || "") + "\\par\\par\n";

  rtf += RESET + "{\\b I. OVERVIEW}\\par\n" + paras(data.overview) + "\n\\par\n";

  rtf += RESET + "{\\b II. CHALLENGES & RECOMMENDATION}\\par\n";
  rtf += rtfTable(
    [["Issues/Concerns/Problems Encountered", "Proposed Recommendations"],
     ...(data.challenges || []).map(c => [c?.issue || "", c?.recommendation || ""])],
    [Math.round(W / 2), Math.round(W / 2)]
  ) + RESET + "\n\\par\n";

  rtf += RESET + "{\\b III. PHOTO DOCUMENTATION}\\par\n";
  photos.slice(0, MAX_PHOTOS).forEach((p, i) => {
    const m = String(p).match(/^data:image\/(\w+);base64,(.*)$/);
    if (!m) return;
    try {
      const hex = base64ToHex(m[2]);
      rtf += "\\par{\\pict\\jpegblip " + hex + "}\\par ";
      const cap = (Array.isArray(data.photoCaptions) ? data.photoCaptions : [])[i] || "";
      if (cap) rtf += RESET + "{\\i\\fs18 " + rtfEscape(cap) + "}\\par\n";
    } catch { /* skip unreadable image */ }
  });
  rtf += RESET + "\\par\n";

  rtf += RESET + "{\\b IV. eGOVPH MATERIAL CONDITION}\\par\n";
  const mf = (template?.fields || []).find(f => f.id === "materials");
  if (mf) {
    const scales = mf.scales || [];
    const opts = mf.options || [];
    const condCols = scales.length * opts.length;
    const labelW = Math.round(W * 0.28);
    rtf += rtfTable(
      [["Materials", "Condition Level", ...Array(condCols - 1).fill("")],
       ["", ...scales.flatMap(s => [s.label, ...Array(opts.length - 1).fill("")])],
       ["", ...scales.flatMap(() => opts.map(o => o.label))],
       ...(mf.rows || []).map(r => [r.label, ...scales.flatMap(s => opts.map(o =>
         data.materials?.[r.id]?.[s.id] === o.id ? "●" : ""))])
      ],
      [labelW, ...Array(condCols).fill(Math.round((W - labelW) / condCols))]
    ) + RESET + "\n";
    if (mf.note) rtf += RESET + "{\\i Note: " + rtfEscape(mf.note) + "}\\par\n";
    for (const l of mf.legend || []) rtf += RESET + "{\\fs18 " + rtfEscape(l) + "}\\par\n";
    rtf += "\\par\n";
  }

  const labels = { preparedBy: "Prepared by:", reviewedBy: "Reviewed by:", approvedBy: "Approved by:" };
  const sigIds = ["preparedBy", "reviewedBy", "approvedBy"]
    .filter(id => (template?.fields || []).some(f => f.id === id && f.type === "person"));
  if (sigIds.length) {
    rtf += rtfTable(
      [sigIds.map(id => labels[id]),
       sigIds.map(id => data[id]?.name || ""),
       sigIds.map(id => data[id]?.position || "")],
      Array(sigIds.length).fill(Math.round(W / sigIds.length))
    ) + RESET + "\n";
  }
  rtf += "}";
  return rtf;
};

// ILCDB After Activity Report RTF — mirrors buildIlcdbPdfBlocks' sections in
// the shared RTF conventions (rtfTable/paras/rtfEscape) above.
const buildIlcdbRtf = (data, photos, template) => {
  const W = 9644; // usable text width in twips (17 cm)
  const RESET = "\\pard\\plain\\f0\\fs22 ";
  const paras = (s) => String(s || "")
    .split(/\n+/).map(x => x.trim()).filter(Boolean)
    .map(x => "\\pard\\fi567\\sl360 " + rtfEscape(x) + "\\par")
    .join("\n");
  const bullets = (s) => String(s || "")
    .split(/\n+/).map(x => x.trim()).filter(Boolean)
    .map(x => "\\pard\\fi567\\sl360 \\bullet\\tab " + rtfEscape(x) + "\\par")
    .join("\n");

  // Objective bullets: skip any model-generated duplicate of the intro line.
  const objectiveLines = paras(data.objectives)
    .filter(l => !/^\s*upon\s+completion\s+of\s+the\s+course/i.test(l))
    .map(l => l.replace(/^[•●]\s*/, "").trim())
    .filter(Boolean);

  let rtf = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n" +
    "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}\n" +
    "{\\colortbl;\\red0\\green0\\blue204;\\red255\\green255\\blue255;}\n" +
    "\\paperw11906\\paperh16838\n" +
    "\\margl1134\\margr1134\\margt1134\\margb1134\n" +
    RESET + "\n";

  rtf += RESET + "{\\b\\fs28 AFTER ACTIVITY REPORT}\\par\\par\n";
  rtf += RESET + "{\\b I. TRAINING DETAILS}\\par\n";
  rtf += RESET + "{\\b Course Title:} " + rtfEscape(data.courseTitle || "") + "\\par\n";
  rtf += RESET + "{\\b Course Code:} " + rtfEscape(data.courseCode || "") + "\\par\n";
  rtf += RESET + "{\\b Date:} " + rtfEscape(data.dateTime || "") + "\\par\n";
  rtf += RESET + "{\\b Time:} " + rtfEscape(data.time || "") + "\\par\n";
  rtf += RESET + "{\\b Duration:} " + rtfEscape(data.duration || "") + "\\par\n";
  rtf += RESET + "{\\b Venue:} " + rtfEscape(data.venue || "") + "\\par\n";
  rtf += RESET + "{\\b Course Officer:} " + rtfEscape(data.courseOfficer || "") + "\\par\n";
  rtf += RESET + "{\\b Admin Assistant:} " + rtfEscape(data.adminAssistant || "") + "\\par\n";
  rtf += RESET + "{\\b Technical Support:} " + rtfEscape(data.technicalSupport || "") + "\\par\n";
  rtf += RESET + "{\\b Resource Person:} " + rtfEscape(data.resourcePerson || "") + "\\par\n";
  rtf += RESET + "{\\b Platform Used:} " + rtfEscape(data.platformUsed || "") + "\\par\n";
  rtf += RESET + "{\\b Mode:} " + rtfEscape(data.mode || "") + "\\par\n";
  rtf += RESET + "{\\b Target Participants:} " + rtfEscape(data.targetParticipants || "") + "\\par\\par\n";

  const benField = beneficiaryFieldOf(template);
  if (benField) {
    const cats = benField.categories || [];
    const b = data.beneficiaries || {};
    const num = value => Number(value || 0);
    const sum = g => cats.reduce((s, c) => s + num(b[c.id]?.[g]), 0);
    rtf += RESET + "{\\b Total # of Attendees (with/without submitted Evaluation Form/Output): " + (sum("male") + sum("female")) + " - Male " + sum("male") + " | Female " + sum("female") + "}\\par\\par\n";
    rtf += RESET + "{\\b\\i Number of Beneficiary/ies with Sex Disaggregation}\\par\n";
    rtf += rtfTable(
      [["Sector Category", "Total", "Male", "Female"],
       ...cats.map(c => [c.label,
                         String(num(b[c.id]?.male) + num(b[c.id]?.female)),
                         String(num(b[c.id]?.male)),
                         String(num(b[c.id]?.female))])],
      [Math.round(W * 0.3), Math.round(W * 0.2), Math.round(W * 0.25), Math.round(W * 0.25)]
    ) + RESET + "\n";
    rtf += RESET + "{\\b Total # of Issued Certificates (with submitted Evaluation Form/Output):} " + rtfEscape(data.certificatesIssued || "") + "\\par\\par\n";
  }

  rtf += RESET + "{\\b II. RATIONALE}\\par\n" + paras(data.rationale) + "\n\\par\n";
  rtf += RESET + "{\\b III. OBJECTIVES}\\par\n";
  rtf += RESET + "{\\i Upon completion of the course, participants will be able to learn:}\\par\n";
  rtf += bullets(objectiveLines) + "\n";
  if (String(data.topicsCovered || "").trim()) {
    rtf += RESET + "{\\b Topics Covered:}\\par\n" + paras(data.topicsCovered) + "\n";
  }
  rtf += "\\par\n";
  rtf += RESET + "{\\b V. ISSUES AND CONCERNS}\\par\n" +
    (data.issues || []).filter(it => String(it?.issue || "").trim())
      .map(it => RESET + "\\pard\\fi567\\sl360 \\bullet\\tab " + rtfEscape(it.issue) + "\\par\n").join("") + "\\par\n";
  rtf += RESET + "{\\b VI. RECOMMENDATION}\\par\n" +
    (data.recommendations || []).filter(it => String(it?.recommendation || "").trim())
      .map(it => RESET + "\\pard\\fi567\\sl360 \\bullet\\tab " + rtfEscape(it.recommendation) + "\\par\n").join("") + "\\par\n";
  rtf += RESET + "{\\b VII. PLANS AND ACTION ITEMS (NEXT STEPS)}\\par\n" + bullets(data.plansActions) + "\n\\par\n";
  rtf += RESET + "{\\b VIII. PHOTO DOCUMENTATION}\\par\n";
  rtf += rtfPictures(photos) + "\n";
  rtf += RESET + "\\par\n";

  const sigIds = ["preparedBy", "notedBy"]
    .filter(id => (template?.fields || []).some(f => f.id === id && f.type === "person"));
  if (sigIds.length) {
    const labels = { preparedBy: "Prepared by:", notedBy: "Noted by:" };
    rtf += rtfTable(
      [sigIds.map(id => labels[id]),
       sigIds.map(id => data[id]?.name || ""),
       sigIds.map(id => data[id]?.position || "")],
      Array(sigIds.length).fill(Math.round(W / sigIds.length))
    ) + RESET + "\n";
  }
  rtf += "}";
  return rtf;
};

export const buildRtf = (data, photos, template) => {
  if (template?.layout === "egov") return buildEgovRtf(data, photos, template);
  if (template?.layout === "ilcdb") return buildIlcdbRtf(data, photos, template);
  const benField = beneficiaryFieldOf(template);
  const cats = benField?.categories || [];
  const persons = personIds(template);
  const b = data.beneficiaries || {};
  const { male: facilitatorMale, female: facilitatorFemale } = countGenders(data.facilitators);
  const sumCat = (g) => cats.reduce((s, c) => s + (Number(b[c.id]?.[g]) || 0), 0);
  const benMale = sumCat("male");
  const benFemale = sumCat("female");
  const totalMale = facilitatorMale + benMale;
  const totalFemale = facilitatorFemale + benFemale;
  const W = 9644; // usable text width in twips (17 cm)
  const RESET = "\\pard\\plain\\f0\\fs22 ";
  const paras = (s) => String(s || "")
    .split(/\n+/).map(x => x.trim()).filter(Boolean)
    .map(x => "\\pard\\fi567\\sl360 " + rtfEscape(x) + "\\par")
    .join("\n");

  let rtf = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n" +
    "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}\n" +
    "{\\colortbl;\\red0\\green0\\blue204;\\red255\\green255\\blue255;}\n" +
    "\\paperw11906\\paperh16838\n" +
    "\\margl1134\\margr1134\\margt1134\\margb1134\n" +
    RESET + "\n";

  rtf += RESET + "{\\b\\fs28 " + rtfEscape(data.title || "") + "}\\par\\par\n";
  rtf += RESET + "{\\b Date and Time:} " + rtfEscape(data.dateTime || "") + "\\par\n";
  rtf += RESET + "{\\b Mode/Platform/Location:} " + rtfEscape(data.mode || "") + "\\par\n";
  rtf += RESET + "{\\b Control No.:} " + rtfEscape(data.controlNo || "") + "\\par\\par\n";

  rtf += RESET + "{\\b I. RATIONALE}\\par\n" + paras(data.rationale) + "\n\\par\n";
  rtf += RESET + "{\\b II. ATTENDEES}\\par\n";
  rtf += RESET + "{\\b\\i A. Facilitator (DICT)}\\par\n";
  rtf += rtfTable([["Name", "Office", "Gender"], ...data.facilitators.map(f => [f.name || "", f.office || "", f.gender || ""])], [Math.round(W/3), Math.round(W/3), Math.round(W/3)]) + RESET + "\n";
  rtf += RESET + "Male: " + facilitatorMale + " | Female: " + facilitatorFemale + "\\par\\par\n";

  if (benField) {
    const sectionTitle = benField.sectionTitle ||
      `${cats.map(c => c.label).join(" / ")} and other Beneficiaries`;
    rtf += RESET + "{\\b\\i B. " + rtfEscape(sectionTitle) + " (please see attached attendance sheet)}\\par\n";
    rtf += rtfTable([
      cats.flatMap(c => [c.label, c.label]),
      cats.flatMap(() => ["Male", "Female"]),
      cats.flatMap(c => [b[c.id]?.male || "", b[c.id]?.female || ""])
    ], Array(cats.length * 2).fill(W / (cats.length * 2))) + RESET + "\n";
    rtf += RESET + "Male: " + benMale + " | Female: " + benFemale + "\\par\\par\n";
  }

  rtf += RESET + "{\\b\\i C. Consolidated participants}\\par\n";
  rtf += rtfTable([
    ["Total number of male attendees", totalMale],
    ["Total number of female attendees", totalFemale],
    ["Total number of attendees", totalMale + totalFemale]
  ], [Math.round(W * 0.6), Math.round(W * 0.4)]) + RESET + "\n";

  rtf += RESET + "{\\b III. HIGHLIGHTS OF DISCUSSION}\\par\n" + paras(data.highlights) + "\n\\par\n";
  rtf += RESET + "{\\b IV. ANNEXES}\\par\n" + RESET + "{\\b\\i A. PHOTOS (must be action picture)}\\par\n";
  rtf += rtfPictures(photos) + "\n";
  rtf += RESET + "\\par\n";
  if (persons.size > 0) {
    const sigRows = [
      [
        persons.has("preparedBy") ? "Prepared by:" : "",
        persons.has("conformedBy") ? "Conformed by:" : ""
      ],
      [data.preparedBy?.name || "", data.conformedBy?.name || ""],
      [data.preparedBy?.position || "", data.conformedBy?.position || ""]
    ];
    rtf += rtfTable(sigRows, [Math.round(W / 2), Math.round(W / 2)]) + RESET + "\n";
  }
  rtf += RESET + "{\\i Copy furnish: eLGU Project Management Team}\\par\n";
  rtf += "}";
  return rtf;
};

export const exportRtf = (data, photos, template) => {
  data = normalizeReport(data, template);
  const rtf = buildRtf(data, photos, template);
  const blob = new Blob([rtf], { type: "application/rtf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `AAR-${(data.controlNo || data.eventName || data.courseTitle || "report").replace(/[^\w.-]+/g, "_")}.rtf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
