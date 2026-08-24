-- Initial schema for the AAR Generator (Phase 3.1).
-- users / sessions back Phase 4 auth; templates stores template metadata;
-- reports holds one generated AAR per row.

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('encoder', 'admin') NOT NULL DEFAULT 'encoder',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  token CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE templates (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  config JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE reports (
  id CHAR(36) PRIMARY KEY,
  -- Pre-auth: the browser's client id. Phase 4: the owning user's id.
  owner VARCHAR(64) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NULL,
  status ENUM('draft', 'final') NOT NULL DEFAULT 'draft',
  conversation JSON NULL,
  report JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_reports_owner (owner),
  INDEX idx_reports_template (template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
