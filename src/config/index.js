'use strict';

/**
 * Central configuration.
 *
 * All values come from environment variables (see .env.example / design §7).
 * Secrets are read here but MUST NOT be logged or rendered in views.
 */

require('dotenv').config();

/** Parse an integer env var, falling back to a default. */
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a boolean-ish env var ("1"/"true"/"yes"). */
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const NODE_ENV = process.env.NODE_ENV || 'development';

const config = {
  env: NODE_ENV,
  isProd: NODE_ENV === 'production',
  port: int(process.env.PORT, 3000),

  session: {
    secret: process.env.SESSION_SECRET || 'change-me-in-env',
    // secure cookies once we are behind HTTPS (Hostinger prod)
    secure: bool(process.env.SESSION_COOKIE_SECURE, NODE_ENV === 'production'),
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_mvp',
  },

  // Used by the seed script only.
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },

  meta: {
    graphVersion: process.env.GRAPH_VERSION || 'v21.0',
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.PHONE_NUMBER_ID || '',
    wabaId: process.env.WABA_ID || '',
    appSecret: process.env.APP_SECRET || '',
    webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || '',
    baseUrl: 'https://graph.facebook.com',
    // request timeout for outbound Meta calls (ms)
    timeoutMs: int(process.env.META_TIMEOUT_MS, 15000),
  },

  probe: {
    templateName: process.env.PROBE_TEMPLATE_NAME || 'hello_world',
    templateLang: process.env.PROBE_TEMPLATE_LANG || 'en_US',
  },

  worker: {
    sendDelayMs: int(process.env.SEND_DELAY_MS, 1000),
    intervalSec: int(process.env.WORKER_INTERVAL_SEC, 5),
    batch: int(process.env.WORKER_BATCH, 5),
    maxAttempts: int(process.env.MAX_ATTEMPTS, 3),
  },

  queue: {
    driver: process.env.QUEUE_DRIVER || 'db', // 'db' | 'bullmq'
    redisUrl: process.env.REDIS_URL || '',
  },

  upload: {
    // max CSV upload size in bytes (default 5 MB)
    maxBytes: int(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
  },
};

module.exports = config;
