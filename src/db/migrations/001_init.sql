-- ---------------------------------------------------------------------------
-- Migration 001 — initial schema
-- All tables InnoDB / utf8mb4. Timestamps are DATETIME in UTC (design §3).
-- Idempotent: uses CREATE TABLE IF NOT EXISTS so re-running is safe.
-- ---------------------------------------------------------------------------

-- admins: single MVP admin (seeded)
CREATE TABLE IF NOT EXISTS admins (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- contacts: known recipients (deduped by e164)
CREATE TABLE IF NOT EXISTS contacts (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  e164        VARCHAR(20) NOT NULL UNIQUE,
  raw_input   VARCHAR(64) NULL,
  country     VARCHAR(4)  NULL,
  name        VARCHAR(120) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- validation_results: one row per validation attempt (Tier A or B)
CREATE TABLE IF NOT EXISTS validation_results (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  batch_id     VARCHAR(36) NULL,             -- groups a bulk upload; NULL for single
  raw_input    VARCHAR(64) NOT NULL,
  e164         VARCHAR(20) NULL,
  country      VARCHAR(4)  NULL,
  number_type  VARCHAR(20) NULL,             -- mobile/fixed_line/etc from libphonenumber
  check_type   ENUM('format','deliverability') NOT NULL,
  is_valid     TINYINT(1) NOT NULL,          -- Tier A format validity
  status       ENUM('valid','invalid','accepted','failed','pending') NOT NULL,
  reason       VARCHAR(255) NULL,            -- error/why
  wamid        VARCHAR(128) NULL,            -- set for Tier B accepted sends
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_batch (batch_id),
  INDEX idx_e164 (e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- messages: every outbound message (single or bulk item), status via webhook
CREATE TABLE IF NOT EXISTS messages (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wamid         VARCHAR(128) NULL UNIQUE,    -- Meta message id (null until accepted)
  to_e164       VARCHAR(20) NOT NULL,
  direction     ENUM('outbound') NOT NULL DEFAULT 'outbound',
  msg_type      ENUM('template','text') NOT NULL,
  template_name VARCHAR(120) NULL,
  language      VARCHAR(15)  NULL,
  body_preview  VARCHAR(500) NULL,           -- rendered text / template summary
  status        ENUM('accepted','sent','delivered','read','failed') NOT NULL DEFAULT 'accepted',
  error_code    VARCHAR(40)  NULL,
  error_title   VARCHAR(255) NULL,
  error_detail  VARCHAR(500) NULL,
  bulk_job_item_id BIGINT UNSIGNED NULL,     -- link back to bulk item if applicable
  accepted_at   DATETIME NULL,
  sent_at       DATETIME NULL,
  delivered_at  DATETIME NULL,
  read_at       DATETIME NULL,
  failed_at     DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_to (to_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- bulk_jobs: one per CSV send job
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(160) NULL,
  template_name VARCHAR(120) NOT NULL,
  language      VARCHAR(15)  NOT NULL,
  msg_type      ENUM('template','text') NOT NULL DEFAULT 'template',
  variables_map JSON NULL,                   -- how CSV columns map to template vars
  status        ENUM('pending','running','completed','failed','paused') NOT NULL DEFAULT 'pending',
  total_count   INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count    INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count  INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- bulk_job_items: one per recipient in a job (the queue)
CREATE TABLE IF NOT EXISTS bulk_job_items (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  job_id       BIGINT UNSIGNED NOT NULL,
  to_e164      VARCHAR(20) NULL,
  raw_input    VARCHAR(64) NOT NULL,
  variables    JSON NULL,                    -- resolved per-row template variables
  status       ENUM('pending','processing','sent','failed','skipped_invalid') NOT NULL DEFAULT 'pending',
  attempts     INT UNSIGNED NOT NULL DEFAULT 0,
  wamid        VARCHAR(128) NULL,
  error_detail VARCHAR(500) NULL,
  next_attempt_at DATETIME NULL,             -- for backoff
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job (job_id),
  INDEX idx_claim (status, next_attempt_at),
  CONSTRAINT fk_item_job FOREIGN KEY (job_id) REFERENCES bulk_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- webhook_events: raw audit log of every inbound callback (idempotency + debug)
CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  event_hash  VARCHAR(64) NOT NULL,          -- dedupe key (wamid+status+timestamp)
  wamid       VARCHAR(128) NULL,
  payload     JSON NOT NULL,
  processed   TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event_hash (event_hash),
  INDEX idx_wamid (wamid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
