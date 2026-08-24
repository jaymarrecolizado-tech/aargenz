-- Store the report's documentation photos (compressed data URLs) alongside
-- the report so drafts restore completely on any machine.
ALTER TABLE reports ADD COLUMN photos JSON NULL AFTER report;
