-- Audit log (Phase 5.3): who logged in / generated / exported what, and
-- which AI provider + model answered. Written best-effort — never blocks a
-- request. user_id/username are nullable so pre-login failures can be
-- recorded too.
CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id CHAR(36) NULL,
  username VARCHAR(64) NULL,
  action VARCHAR(64) NOT NULL,
  detail VARCHAR(255) NULL,
  provider VARCHAR(32) NULL,
  model VARCHAR(64) NULL,
  INDEX idx_audit_at (at),
  INDEX idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
