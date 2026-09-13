import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

// Admin analytics dashboard (plan 3.3).
//
// The data is already in MySQL and a CSV export exists, but nobody wants to
// build a pivot table to answer "how many activities did we run in December,
// and how many beneficiaries did we reach?" This tab renders that directly.
//
// Charts are hand-rolled from CSS/SVG — no chart library is bundled (the plan
// assumed one, but none is present) so the dashboard adds zero dependency weight
// and works on an air-gapped office LAN without a CDN.

const COL = {
  primary: "#3b6fd4",
  male: "#2f6fb0",
  female: "#d6699b",
  draft: "#9aa3b2",
  submitted: "#e8a33d",
  approved: "#2e9e5b",
  rejected: "#d9534f",
  cat: ["#3b6fd4", "#2e9e5b", "#9b59b6", "#e8a33d"]
};

const CAT_LABELS = { ngas: "NGAs", lgus: "LGUs", sucs: "SUCs", others: "Others" };

export default function Analytics({ templates = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError("");
    api.analytics()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const tplName = (id) => templates.find((t) => t.id === id)?.name || id;

  if (loading && !data) return <div style={{ color: "var(--muted)", fontSize: "13px", padding: "16px 0" }}>Loading analytics…</div>;
  if (error) return <div style={{ background: "#fdecea", color: "#b71c1c", borderRadius: "8px", padding: "10px 12px", fontSize: "12px" }}>{error}</div>;
  if (!data) return null;

  const benTotal = data.beneficiaries.male + data.beneficiaries.female;
  const facTotal = data.facilitators.male + data.facilitators.female;
  const f = data.statusFunnel;

  return (
    <div style={{ width: "100%", maxWidth: "920px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
        <div style={{ fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>Reports &amp; Impact</div>
        <button onClick={load} className="mini-btn" style={{ marginLeft: "auto" }} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {/* Headline stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px", marginBottom: "18px" }}>
        <Stat label="Total reports" value={data.totals.reports} />
        <Stat label="Beneficiaries" value={benTotal} sub={`${data.beneficiaries.male} M · ${data.beneficiaries.female} F`} />
        <Stat label="Facilitators" value={facTotal} sub={`${data.facilitators.male} M · ${data.facilitators.female} F`} />
        <Stat label="Approved" value={f.approved} sub={`of ${data.totals.reports} reports`} accent={COL.approved} />
      </div>

      {/* Reports per month */}
      <Card title="Reports per month (last 12)">
        <MonthChart items={data.byMonth.map((m) => ({ full: m.month, short: fmtMonth(m.month), value: Number(m.count) }))} />
      </Card>

      {/* Lifecycle funnel */}
      <Card title="Lifecycle funnel">
        <StatusFunnel funnel={f} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }} className="analytics-split">
        {/* Per template */}
        <Card title="Reports by template">
          <Bars items={data.byTemplate.map((t) => ({ label: tplName(t.template), value: Number(t.count) }))} />
        </Card>

        {/* Per encoder */}
        <Card title="Reports by encoder">
          <Bars items={data.byEncoder.map((e) => ({ label: e.encoder, value: Number(e.count) }))} color={COL.primary} />
        </Card>
      </div>

      {/* Beneficiary breakdown */}
      <Card title="Beneficiaries by sector (with sex disaggregation)">
        {data.beneficiaries.reportsWithData === 0 ? (
          <Empty>No beneficiary data recorded yet.</Empty>
        ) : (
          <>
            <SexSplit male={data.beneficiaries.male} female={data.beneficiaries.female} />
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "12px", fontSize: "12px" }}>
              <thead>
                <tr>
                  {["Sector", "Male", "Female", "Total"].map((h) => (
                    <th key={h} style={{ textAlign: "left", color: "var(--muted)", padding: "5px 8px", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.keys(CAT_LABELS).map((c) => {
                  const v = data.beneficiaries.byCategory[c] || { male: 0, female: 0 };
                  return (
                    <tr key={c} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "5px 8px", fontWeight: "600", color: "var(--text)" }}>{CAT_LABELS[c]}</td>
                      <td style={{ padding: "5px 8px" }}>{v.male}</td>
                      <td style={{ padding: "5px 8px" }}>{v.female}</td>
                      <td style={{ padding: "5px 8px", fontWeight: "600" }}>{v.male + v.female}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Card>

      {/* Facilitator leaderboard */}
      <Card title="Facilitator leaderboard (most activities facilitated)">
        {data.facilitators.leaderboard.length === 0 ? (
          <Empty>No facilitator data recorded yet.</Empty>
        ) : (
          <Bars items={data.facilitators.leaderboard.map((l) => ({ label: l.name, value: l.count }))} color={COL.primary} />
        )}
      </Card>

      <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "14px" }}>
        Aggregated from {data.totals.reports} report(s). Month counts use the report creation date; beneficiary and facilitator totals come from each report’s content.
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "12px 14px" }}>
      <div style={{ fontSize: "11px", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: "24px", fontWeight: "700", color: accent || "var(--text)", lineHeight: 1.2, marginTop: "2px" }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>{sub}</div>}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "10px", padding: "14px 16px", marginBottom: "14px" }}>
      <div style={{ fontSize: "13px", fontWeight: "700", color: "var(--text)", marginBottom: "10px" }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ color: "var(--muted)", fontSize: "12px", padding: "8px 0" }}>{children}</div>;
}

// Vertical bars for the monthly trend. Pure flex so it scales with the panel.
function MonthChart({ items }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <Empty>No reports in the last 12 months.</Empty>;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "160px" }}>
      {items.map((it) => {
        const h = Math.max(2, Math.round((it.value / max) * 130));
        return (
          <div key={it.full} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }} title={`${it.full}: ${it.value}`}>
            <div style={{ fontSize: "10px", color: "var(--muted)", marginBottom: "3px" }}>{it.value}</div>
            <div style={{ width: "72%", minHeight: "2px", height: `${h}px`, background: COL.primary, borderRadius: "3px 3px 0 0" }} />
            <div style={{ fontSize: "9px", color: "var(--muted)", marginTop: "4px", whiteSpace: "nowrap" }}>{it.short}</div>
          </div>
        );
      })}
    </div>
  );
}

// Horizontal bars (template / encoder / facilitator leaderboard).
function Bars({ items, color = COL.primary }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <Empty>No data.</Empty>;
  return (
    <div>
      {items.map((it, i) => {
        const pct = Math.round((it.value / max) * 100);
        return (
          <div key={it.label + i} style={{ display: "flex", alignItems: "center", gap: "8px", margin: "5px 0" }}>
            <div style={{ width: "150px", flexShrink: 0, fontSize: "12px", color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={it.label}>{it.label}</div>
            <div style={{ flex: 1, background: "#eef1fa", borderRadius: "5px", height: "14px", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: "5px", minWidth: "2px" }} />
            </div>
            <div style={{ width: "34px", textAlign: "right", fontSize: "12px", fontWeight: "600", color: "var(--text)" }}>{it.value}</div>
          </div>
        );
      })}
    </div>
  );
}

// Stacked male/female bar with legend.
function SexSplit({ male, female }) {
  const sum = male + female || 1;
  const segs = [
    { label: "Male", value: male, color: COL.male },
    { label: "Female", value: female, color: COL.female }
  ];
  return (
    <div>
      <div style={{ display: "flex", height: "20px", borderRadius: "6px", overflow: "hidden" }}>
        {segs.map((s) => s.value ? <div key={s.label} style={{ width: `${(s.value / sum) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} /> : null)}
      </div>
      <div style={{ display: "flex", gap: "14px", marginTop: "7px" }}>
        {segs.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px" }}>
            <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: s.color, display: "inline-block" }} />
            {s.label} <b>{s.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusFunnel({ funnel }) {
  const sum = funnel.draft + funnel.submitted + funnel.approved + funnel.rejected || 1;
  const segs = [
    { label: "Draft", value: funnel.draft, color: COL.draft },
    { label: "Submitted", value: funnel.submitted, color: COL.submitted },
    { label: "Approved", value: funnel.approved, color: COL.approved },
    { label: "Rejected", value: funnel.rejected, color: COL.rejected }
  ];
  return (
    <div>
      <div style={{ display: "flex", height: "22px", borderRadius: "6px", overflow: "hidden" }}>
        {segs.map((s) => s.value ? <div key={s.label} style={{ width: `${(s.value / sum) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} /> : null)}
      </div>
      <div style={{ display: "flex", gap: "14px", marginTop: "9px", flexWrap: "wrap" }}>
        {segs.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px" }}>
            <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: s.color, display: "inline-block" }} />
            {s.label} <b>{s.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtMonth(m) {
  try {
    return new Date(m + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  } catch {
    return m;
  }
}
