-- Optimistic concurrency on autosave (plan 2.7).

-- Why a dedicated counter instead of reusing updated_at: updated_at is a
-- TIMESTAMP with one-second resolution, so two saves landing in the same second
-- are indistinguishable and the second would silently win. A monotonic integer
-- has no such ambiguity.
--
-- The check is applied atomically in the UPDATE itself
-- (UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?), so there
-- is no read-then-write window for two encoders to slip through.
ALTER TABLE reports ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER status;
