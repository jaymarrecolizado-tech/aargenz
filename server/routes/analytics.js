// Admin analytics dashboard (plan 3.3).
//
// One admin-only GET that returns the aggregates the regional office asks for in
// its upward reporting: reports per month / template / encoder, the draft →
// submitted → approved/rejected funnel, and the beneficiary + facilitator totals
// (with sex disaggregation). The SQL layer handles the group-by counts; the
// beneficiary/facilitator JSON is folded in Node by server/lib/analytics.js, which
// keeps the logic portable across MySQL/MariaDB and unit-testable.


import { getPool } from "../../db.js";
import { foldReports } from "../lib/analytics.js";

export async function handleAnalytics(ctx) {
  const { req, res, url, sendJson, requireAdmin, writeAudit } = ctx;

  // Admin analytics dashboard (plan 3.3). Admin-only; loaded on demand.
  if (url.pathname !== "/api/analytics") return;
  if (req.method !== "GET") return sendJson(405, { error: { message: "Method not allowed" } });

  const admin = await requireAdmin();
  if (!admin) return; // requireAdmin already sent 401/403

  const pool = getPool();
  try {
    // Reports created per month — the trailing-12-month window the office asks
    // about ("how many activities in December?"). created_at is used because the
    // activity date is free text inside the report JSON and cannot be indexed.
    const [byMonth] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
       FROM reports
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month ASC`
    );

    // Reports per template (id only; the client maps id → name from the
    // template picker list it already holds).
    const [byTemplate] = await pool.query(
      `SELECT template_id AS template, COUNT(*) AS count
       FROM reports GROUP BY template_id ORDER BY count DESC`
    );

    // Reports per encoder (owner). COALESCE covers reports whose owner account
    // was deleted — DICT keeps the records but they lose their owner.
    const [byEncoder] = await pool.query(
      `SELECT COALESCE(u.username, 'Unknown') AS encoder, COUNT(*) AS count
       FROM reports r LEFT JOIN users u ON u.id = r.owner
       GROUP BY r.owner ORDER BY count DESC`
    );

    // Lifecycle funnel. Four known states; anything unexpected defaults to 0.
    const [statusRows] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM reports GROUP BY status`
    );
    const statusFunnel = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
    for (const r of statusRows) {
      if (r.status in statusFunnel) statusFunnel[r.status] = Number(r.count);
    }

    // Beneficiary + facilitator totals need the per-report JSON. Only the
    // `report` column is read (no conversation; photos live in their own table
    // since plan 2.6), and foldReports parses the MariaDB string form.
    const [reportRows] = await pool.query("SELECT template_id, report FROM reports");
    const folded = foldReports(reportRows);

    writeAudit(admin, "analytics.view", {
      detail: `${reportRows.length} report(s) aggregated`
    });

    return sendJson(200, {
      generatedAt: new Date().toISOString(),
      totals: { reports: reportRows.length },
      byMonth,
      byTemplate,
      byEncoder,
      statusFunnel,
      beneficiaries: {
        male: folded.benMale,
        female: folded.benFemale,
        byCategory: folded.benByCat,
        reportsWithData: folded.reportsWithBeneficiaries
      },
      facilitators: {
        male: folded.facilitatorMale,
        female: folded.facilitatorFemale,
        reportsWithData: folded.reportsWithFacilitators,
        leaderboard: folded.facilitatorLeaderboard
      }
    });
  } catch (e) {
    console.error("[analytics]", e.message);
    return sendJson(500, { error: { message: "Database error: " + e.message } });
  }
}
