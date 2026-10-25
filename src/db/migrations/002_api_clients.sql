-- ---------------------------------------------------------------------------
-- Migration 002 — API clients (multi-project access)
-- Each consuming project gets its own API key. Only a SHA-256 hash of the key
-- is stored; the plaintext key is shown once at creation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_clients (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  key_prefix    VARCHAR(16)  NOT NULL,          -- first chars, for display only
  key_hash      CHAR(64)     NOT NULL UNIQUE,   -- sha256(key) hex
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  last_used_at  DATETIME     NULL,
  revoked_at    DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tag each message with the project that sent it (NULL = sent from the admin UI)
-- plus the caller's own reference id (e.g. their order id).
ALTER TABLE messages
  ADD COLUMN api_client_id INT UNSIGNED NULL AFTER bulk_job_item_id,
  ADD COLUMN client_ref    VARCHAR(120) NULL AFTER api_client_id,
  ADD INDEX idx_api_client (api_client_id);
