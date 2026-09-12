// Moves photos out of the legacy reports.photos JSON column into the
// report_photos table (plan 2.6, migration 0004).
//
// Safe to re-run: it only touches rows that still carry photos in the legacy
// column, and it clears that column only after the rows are committed. Reports
// that already have rows in report_photos are skipped.
//
// Usage: node scripts/migrate-photos.js [--dry-run]
import { getPool, closePool } from "../db.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

// Small test images are common in dev data; "0 KB" reads like a failure.
const humanSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);

function parseLegacy(value) {
  let arr = value;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const item of arr) {
    const dataUrl = typeof item === "string" ? item : item?.dataUrl;
    const caption = item && typeof item === "object" && item.caption != null
      ? String(item.caption).slice(0, 255)
      : null;
    const m = DATA_URL_RE.exec(String(dataUrl || ""));
    if (!m) {
      console.warn(`    ! skipping an unrecognised entry (not a base64 image data URL)`);
      continue;
    }
    out.push({ mime: m[1].toLowerCase(), bytes: Buffer.from(m[2].replace(/\s+/g, ""), "base64"), caption });
  }
  return out;
}

async function main() {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT r.id, r.photos
     FROM reports r
     WHERE r.photos IS NOT NULL AND LENGTH(r.photos) > 2
       AND NOT EXISTS (SELECT 1 FROM report_photos p WHERE p.report_id = r.id)`
  );

  if (!rows.length) {
    console.log("Nothing to migrate — no report still carries photos in the legacy column.");
    await closePool();
    return;
  }

  console.log(`Found ${rows.length} report(s) with legacy photos${DRY_RUN ? " (dry run)" : ""}.`);
  let moved = 0, photos = 0, failed = 0;

  for (const row of rows) {
    const parsed = parseLegacy(row.photos);
    if (parsed === null) {
      console.warn(`  ${row.id.slice(0, 8)}  unreadable photos JSON — left untouched`);
      failed++;
      continue;
    }
    if (!parsed.length) {
      console.log(`  ${row.id.slice(0, 8)}  no usable photos — clearing the legacy column`);
      if (!DRY_RUN) await pool.query("UPDATE reports SET photos = NULL WHERE id = ?", [row.id]);
      continue;
    }
    const bytes = parsed.reduce((n, p) => n + p.bytes.length, 0);
    console.log(`  ${row.id.slice(0, 8)}  ${parsed.length} photo(s), ${humanSize(bytes)}`);
    if (DRY_RUN) { moved++; photos += parsed.length; continue; }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        await conn.query(
          "INSERT INTO report_photos (report_id, seq, mime, bytes, caption) VALUES (?, ?, ?, ?, ?)",
          [row.id, i, p.mime, p.bytes, p.caption]
        );
      }
      await conn.query("UPDATE reports SET photos = NULL WHERE id = ?", [row.id]);
      await conn.commit();
      moved++;
      photos += parsed.length;
    } catch (e) {
      await conn.rollback();
      console.error(`    FAILED: ${e.message}`);
      failed++;
    } finally {
      conn.release();
    }
  }

  console.log(
    DRY_RUN
      ? `Dry run complete — would move ${photos} photo(s) from ${moved} report(s).`
      : `Migrated ${photos} photo(s) from ${moved} report(s)${failed ? `, ${failed} failed` : ""}.`
  );
  await closePool();
}

main().catch(async (e) => {
  console.error("Photo migration failed:", e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
