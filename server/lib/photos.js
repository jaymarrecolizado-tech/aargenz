// Report photos (plan 2.6).
// Photos live in report_photos instead of inside the reports row, so a draft's
// megabytes of base64 no longer ride along with every read and every autosave.


// ---- Report photos (plan 2.6) ----------------------------------------------
// Photos live in report_photos instead of inside the reports row, so a draft
// carrying 1.5-3 MB of base64 no longer rides along with every report read and
// every autosave. The client sends data URLs; they are decoded and stored as
// bytes so the DB no longer pays the ~33% base64 overhead either.
export const MAX_REPORT_PHOTOS = Number(process.env.MAX_REPORT_PHOTOS || 10);
export const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES || 3 * 1024 * 1024);
export const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

// Returns { photos: [{ mime, bytes, caption }] } or { error }.
export function parsePhotoPayload(items) {
  if (!Array.isArray(items)) return { photos: [] };
  if (items.length > MAX_REPORT_PHOTOS) {
    return { error: { message: `A report can hold at most ${MAX_REPORT_PHOTOS} photos` } };
  }
  const photos = [];
  for (const item of items) {
    const dataUrl = typeof item === "string" ? item : item?.dataUrl;
    const caption = item && typeof item === "object" && item.caption != null
      ? String(item.caption).slice(0, 255)
      : null;
    const m = DATA_URL_RE.exec(String(dataUrl || ""));
    if (!m) return { error: { message: "Each photo must be a base64 image data URL" } };
    const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
    if (bytes.length > MAX_PHOTO_BYTES) {
      return { error: { message: `A photo exceeds the ${Math.round(MAX_PHOTO_BYTES / 1048576)} MB limit` } };
    }
    photos.push({ mime: m[1].toLowerCase(), bytes, caption });
  }
  return { photos };
}

// Replaces a report's whole photo set in one transaction. Replace-all keeps the
// client simple (it just sends the current array) and preserves ordering, so
// drag-to-reorder works later without a schema change.
export async function replaceReportPhotos(pool, reportId, items) {
  const parsed = parsePhotoPayload(items);
  if (parsed.error) return parsed;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM report_photos WHERE report_id = ?", [reportId]);
    for (let i = 0; i < parsed.photos.length; i++) {
      const p = parsed.photos[i];
      await conn.query(
        "INSERT INTO report_photos (report_id, seq, mime, bytes, caption) VALUES (?, ?, ?, ?, ?)",
        [reportId, i, p.mime, p.bytes, p.caption]
      );
    }
    // Clear the legacy column so the two stores can never disagree.
    await conn.query("UPDATE reports SET photos = NULL WHERE id = ?", [reportId]);
    await conn.commit();
    return { count: parsed.photos.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Reads a report's photos as data URLs, falling back to the legacy
// reports.photos column so reports saved before the migration keep working
// until scripts/migrate-photos.js has moved them.
export async function loadReportPhotos(pool, reportId) {
  const [rows] = await pool.query(
    "SELECT seq, mime, bytes, caption FROM report_photos WHERE report_id = ? ORDER BY seq",
    [reportId]
  );
  if (rows.length) {
    return rows.map(r => ({
      dataUrl: `data:${r.mime};base64,${Buffer.from(r.bytes).toString("base64")}`,
      caption: r.caption || ""
    }));
  }
  const [legacy] = await pool.query("SELECT photos FROM reports WHERE id = ?", [reportId]);
  let arr = legacy[0]?.photos;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = null; } }
  return Array.isArray(arr)
    ? arr.filter(u => typeof u === "string").map(u => ({ dataUrl: u, caption: "" }))
    : [];
}
