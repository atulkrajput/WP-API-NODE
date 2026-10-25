-- ---------------------------------------------------------------------------
-- Migration 003 — incoming messages, opt-outs, 24h window, project callbacks
-- ---------------------------------------------------------------------------

-- Per-project callback endpoint. The secret signs each delivery (HMAC-SHA256),
-- so it is stored in plaintext (the project needs the same value to verify).
ALTER TABLE api_clients
  ADD COLUMN callback_url    VARCHAR(500) NULL AFTER key_hash,
  ADD COLUMN callback_secret VARCHAR(80)  NULL AFTER callback_url;

-- Contact state: last inbound message opens a 24h free-text window; STOP sets
-- opted_out_at and blocks all sends until the contact sends START.
ALTER TABLE contacts
  ADD COLUMN last_inbound_at DATETIME NULL,
  ADD COLUMN opted_out_at    DATETIME NULL,
  ADD COLUMN updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Every incoming customer message.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wamid          VARCHAR(128) NOT NULL UNIQUE,
  from_e164      VARCHAR(20)  NOT NULL,
  contact_name   VARCHAR(120) NULL,
  msg_type       VARCHAR(30)  NOT NULL,          -- text, image, button, interactive, ...
  text_body      TEXT         NULL,              -- text / caption / button title
  media_id       VARCHAR(128) NULL,
  context_wamid  VARCHAR(128) NULL,              -- the outbound message this replies to
  opt_action     ENUM('opted_out','opted_in') NULL,
  api_client_id  INT UNSIGNED NULL,              -- project this was routed to
  payload        JSON         NOT NULL,
  received_at    DATETIME     NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_from (from_e164, id),
  INDEX idx_client (api_client_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbox of callbacks to projects, retried with backoff by the dispatcher.
CREATE TABLE IF NOT EXISTS callback_deliveries (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  api_client_id   INT UNSIGNED NOT NULL,
  event           VARCHAR(40)  NOT NULL,         -- message.status, message.received, ping
  payload         MEDIUMTEXT   NOT NULL,         -- exact JSON body sent
  status          ENUM('pending','sending','delivered','failed') NOT NULL DEFAULT 'pending',
  attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME     NULL,
  response_code   INT          NULL,
  last_error      VARCHAR(500) NULL,
  delivered_at    DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_due (status, next_attempt_at),
  INDEX idx_client (api_client_id, id),
  CONSTRAINT fk_cb_client FOREIGN KEY (api_client_id) REFERENCES api_clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
