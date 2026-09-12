-- Control numbers (plan 3.2) + photo storage (plan 2.6).

-- ---- Control numbers -------------------------------------------------------
-- A per-template, per-year counter. The office currently types the control
-- number by hand (template field `controlNo`, example "eLGU-R2-12-04-2025-S157"),
-- which is a guaranteed source of duplicates and typos across encoders.
CREATE TABLE control_sequences (
  template_id VARCHAR(64) NOT NULL,
  year SMALLINT NOT NULL,
  last_seq INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (template_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The issued number lives on the row rather than buried inside the report JSON,
-- so it can be indexed, searched and made genuinely unique. NULL for templates
-- that don't use control numbers (MySQL allows many NULLs under a UNIQUE index).
ALTER TABLE reports ADD COLUMN control_no VARCHAR(64) NULL AFTER title;
ALTER TABLE reports ADD UNIQUE INDEX idx_reports_control_no (control_no);

-- ---- Photo storage ---------------------------------------------------------
-- A draft with 10 compressed photos is 1.5-3 MB of base64 sitting in the
-- reports row, which was read and rewritten on every single-report fetch and
-- every autosave. Photos move here and are fetched separately.
-- The legacy reports.photos column is deliberately left in place: the API still
-- reads it as a fallback so existing reports keep working until
-- `node scripts/migrate-photos.js` has moved their data across.
CREATE TABLE report_photos (
  report_id CHAR(36) NOT NULL,
  seq INT NOT NULL,
  mime VARCHAR(32) NOT NULL,
  bytes MEDIUMBLOB NOT NULL,
  caption VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, seq),
  CONSTRAINT fk_report_photos_report FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
