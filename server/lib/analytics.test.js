import { describe, it, expect } from "vitest";
import { foldReports, BENEFICIARY_CATS } from "./analytics.js";

describe("foldReports (plan 3.3 aggregation)", () => {
  it("sums beneficiary male/female across all categories and reports", () => {
    const rows = [
      { report: { beneficiaries: { ngas: { male: 5, female: 3 }, lgus: { male: 2, female: 1 } } } },
      { report: { beneficiaries: { ngas: { male: 1, female: 1 }, sucs: { male: 4, female: 4 } } } }
    ];
    const out = foldReports(rows);
    expect(out.benMale).toBe(5 + 2 + 1 + 4);
    expect(out.benFemale).toBe(3 + 1 + 1 + 4);
    expect(out.benByCat.ngas).toEqual({ male: 6, female: 4 });
    expect(out.benByCat.lgus).toEqual({ male: 2, female: 1 });
    expect(out.benByCat.sucs).toEqual({ male: 4, female: 4 });
    expect(out.benByCat.others).toEqual({ male: 0, female: 0 });
    expect(out.reportsWithBeneficiaries).toBe(2);
  });

  it("tolerates stringified JSON (XAMPP MariaDB LONGTEXT) and bad rows", () => {
    const rows = [
      { report: JSON.stringify({ beneficiaries: { lgus: { male: 7, female: 8 } } }) },
      { report: "not json" },
      { report: null },
      {}
    ];
    const out = foldReports(rows);
    expect(out.benMale).toBe(7);
    expect(out.benFemale).toBe(8);
    expect(out.reportsWithBeneficiaries).toBe(1);
  });

  it("counts each facilitator once per report and splits gender tolerantly", () => {
    const rows = [
      {
        report: {
          facilitators: [
            { name: "JUAN DELA CRUZ", gender: "M" },
            { name: "juan dela cruz", gender: "M" }, // duplicate name → counted once
            { name: "MARIA SANTOS", gender: "Female" },
            { name: "Legacy Person", gender: "male" } // legacy casing
          ]
        }
      },
      { report: { facilitators: [{ name: "MARIA SANTOS", gender: "F" }] } } // appears again
    ];
    const out = foldReports(rows);
    // Gender tallies every facilitator entry (so a name listed twice in one
    // report counts twice) — this matches countGenders() in the previews. The
    // leaderboard, by contrast, counts each distinct name once per report.
    expect(out.facilitatorMale).toBe(3); // Juan + Juan(dup) + Legacy
    expect(out.facilitatorFemale).toBe(2); // Maria in both reports
    expect(out.reportsWithFacilitators).toBe(2);
    const board = out.facilitatorLeaderboard;
    const maria = board.find((b) => b.name === "MARIA SANTOS");
    const juan = board.find((b) => b.name === "JUAN DELA CRUZ");
    expect(maria.count).toBe(2);
    expect(juan.count).toBe(1);
    // Leaderboard is sorted descending by count.
    expect(board[0].count).toBeGreaterThanOrEqual(board[board.length - 1].count);
  });

  it("ignores non-numeric beneficiary entries", () => {
    const rows = [{ report: { beneficiaries: { ngas: { male: "many", female: null } } } }];
    const out = foldReports(rows);
    expect(out.benMale).toBe(0);
    expect(out.benFemale).toBe(0);
    expect(out.reportsWithBeneficiaries).toBe(0);
  });

  it("returns all four category buckets even with no data", () => {
    const out = foldReports([]);
    expect(Object.keys(out.benByCat).sort()).toEqual([...BENEFICIARY_CATS].sort());
  });
});
