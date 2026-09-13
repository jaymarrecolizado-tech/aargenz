-- Approval / review workflow (plan 3.1).
--
-- A government AAR has a lifecycle: it is prepared, submitted, reviewed, and
-- approved — and once approved it must be an immutable record. `status` was
-- ENUM('draft','final'); it becomes ENUM('draft','submitted','approved','rejected').
--
-- Legacy 'final' maps to 'draft', NOT to 'submitted'. The old client sent
-- `status: reportData ? "final" : "draft"` on every autosave, so 'final' meant
-- "this row has report data" and was never a deliberate act by anyone. Mapping
-- it to 'submitted' would fabricate six review requests nobody made. Those rows
-- keep their content and their owner simply submits them when they are ready.
--
-- The three ALTERs are ordered on purpose: widen the enum, rewrite the data,
-- then narrow it. Doing it in one step would truncate every 'final' to ''.

ALTER TABLE reports
  MODIFY COLUMN status ENUM('draft','final','submitted','approved','rejected')
    NOT NULL DEFAULT 'draft';

UPDATE reports SET status = 'draft' WHERE status = 'final';

ALTER TABLE reports
  MODIFY COLUMN status ENUM('draft','submitted','approved','rejected')
    NOT NULL DEFAULT 'draft';

-- Who moved it, and when. The acting user's username is snapshotted next to the
-- id, exactly as audit_log does it (0003), so the approval stays attributable
-- even if that account is later deleted. An approved government record must not
-- lose the name of the person who approved it.
ALTER TABLE reports
  ADD COLUMN submitted_by      CHAR(36)    NULL AFTER status,
  ADD COLUMN submitted_by_name VARCHAR(64) NULL AFTER submitted_by,
  ADD COLUMN submitted_at      TIMESTAMP   NULL AFTER submitted_by_name,
  ADD COLUMN reviewed_by       CHAR(36)    NULL AFTER submitted_at,
  ADD COLUMN reviewed_by_name  VARCHAR(64) NULL AFTER reviewed_by,
  ADD COLUMN reviewed_at       TIMESTAMP   NULL AFTER reviewed_by_name,
  ADD COLUMN remarks           TEXT        NULL AFTER reviewed_at;

-- The reviewer queue is "everything currently submitted", so make that cheap.
ALTER TABLE reports ADD INDEX idx_reports_status (status);
