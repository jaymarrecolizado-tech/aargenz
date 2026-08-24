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

export const buildFooterLabel = (data) => {
  const title = data.title || "";
  const date = (data.dateTime || "").split("|")[0]?.trim() || "";
  return `[${escapeHtml(title)} on ${escapeHtml(date)}]`;
};

// Shared helpers for template-driven rendering.
const beneficiaryFieldOf = (template) =>
  (template?.fields || []).find(f => f.type === "beneficiaries");

const personIds = (template) =>
  new Set((template?.fields || []).filter(f => f.type === "person").map(f => f.id));

export const buildPdfBlocks = (data, photos, headerImgData, template, photoLayout = "classic") => {
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
  const footerLabel = buildFooterLabel(data);
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

export const buildRtf = (data, photos, template) => {
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
  a.download = `AAR-${(data.controlNo || "report").replace(/[^\w.-]+/g, "_")}.rtf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
