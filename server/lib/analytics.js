// Pure aggregation of per-report JSON for the admin analytics dashboard (plan 3.3).
//
// Kept free of any DB / Node-only imports so it can be unit-tested under vitest
// and reused by server/routes/analytics.js. The SQL layer hands back the raw
// `report` column (a JSON object on MySQL, a string on XAMPP/MariaDB where JSON
// is an alias for LONGTEXT), and this folds it into the beneficiary / facilitator
// totals the dashboard renders.
//
// Beneficiary categories are the four the templates share: NGAs / LGUs / SUCs /
// Others. Facilitators are tallied once per report (a name that appears twice in
// the same activity counts as one facilitation), and their gender feeds the
// male/female split using the same tolerant M/F matching the previews use.

export const BENEFICIARY_CATS = ["ngas", "lgus", "sucs", "others"];

export function emptyBeneficiaryCat() {
  return { male: 0, female: 0 };
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Gender is stored loosely: "M"/"F" on new reports, free text ("Male", " m ")
// on legacy ones. This mirrors countGenders in the previews.
function genderKey(raw) {
  const g = String(raw || "").trim().toUpperCase();
  if (g === "M" || g === "MALE" || g === "MAN") return "M";
  if (g === "F" || g === "FEMALE" || g === "WOMAN") return "F";
  return null;
}

// `reportRows` is an array of { report } where `report` may be an object or a
// JSON string. Returns the folded beneficiary/facilitator aggregates.
export function foldReports(reportRows) {
  const totals = {
    benMale: 0,
    benFemale: 0,
    benByCat: Object.fromEntries(BENEFICIARY_CATS.map((c) => [c, emptyBeneficiaryCat()])),
    facilitatorMale: 0,
    facilitatorFemale: 0,
    reportsWithBeneficiaries: 0,
    reportsWithFacilitators: 0
  };
  const facCountMap = new Map();

  for (const row of reportRows || []) {
    let report = row?.report;
    if (typeof report === "string") {
      try { report = JSON.parse(report); } catch { report = null; }
    }
    if (!report || typeof report !== "object") continue;

    // Beneficiary breakdown (male/female per category).
    const ben = report.beneficiaries;
    if (ben && typeof ben === "object") {
      let any = false;
      for (const cat of BENEFICIARY_CATS) {
        const c = ben[cat];
        if (!c || typeof c !== "object") continue;
        const m = asNumber(c.male);
        const f = asNumber(c.female);
        if (m || f) any = true;
        totals.benByCat[cat].male += m;
        totals.benByCat[cat].female += f;
        totals.benMale += m;
        totals.benFemale += f;
      }
      if (any) totals.reportsWithBeneficiaries++;
    }

    // Facilitators: tally each distinct name once per report, and split gender.
    const facs = Array.isArray(report.facilitators) ? report.facilitators : [];
    if (facs.length) {
      totals.reportsWithFacilitators++;
      const seen = new Set();
      for (const f of facs) {
        if (!f || typeof f !== "object") continue;
        const g = genderKey(f.gender);
        if (g === "M") totals.facilitatorMale++;
        else if (g === "F") totals.facilitatorFemale++;
        const name = String(f.name || "").trim();
        if (name && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          facCountMap.set(name, (facCountMap.get(name) || 0) + 1);
        }
      }
    }
  }

  const facilitatorLeaderboard = [...facCountMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return { ...totals, facilitatorLeaderboard };
}
