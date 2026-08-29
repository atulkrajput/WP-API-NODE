'use strict';

/**
 * WhatsAppService — Meta WhatsApp Cloud API wrapper (design §5).
 *
 * Thin, testable wrapper around a shared axios instance that talks to the Meta
 * Graph API. It exposes two send primitives:
 *
 *   - `sendTemplate(to, name, lang, components)` — the default send path
 *     (Requirement 5.1). Templates are the only thing deliverable outside the
 *     24-hour session window and are used for the Tier B deliverability probe
 *     (Requirement 3).
 *   - `sendText(to, body)` — free-text send, only deliverable inside an open
 *     session window (Requirement 5.2).
 *
 * Both normalize Meta's responses into a stable shape the callers persist:
 *   - success → { ok: true,  wamid, raw }
 *   - failure → { ok: false, code, title, detail, raw }
 *
 * NFR-2: every call has a timeout, Meta error payloads are translated into
 * human-readable reasons, and the access token is NEVER logged or returned.
 */

const axios = require('axios');
const config = require('../config');

const MESSAGING_PRODUCT = 'whatsapp';

/**
 * Build the shared axios instance.
 *
 * Base URL is `{baseUrl}/{graphVersion}/{phoneNumberId}` so callers post to
 * `/messages` (design §5). The bearer token lives only in the default headers
 * of this instance — it is never included in normalized results or log output.
 *
 * @param {object} [meta] override config.meta (used by tests)
 * @returns {import('axios').AxiosInstance}
 */
function buildClient(meta = config.meta) {
  return axios.create({
    baseURL: `${meta.baseUrl}/${meta.graphVersion}/${meta.phoneNumberId}`,
    timeout: meta.timeoutMs,
    headers: {
      Authorization: `Bearer ${meta.token}`,
      'Content-Type': 'application/json',
    },
  });
}

// A single shared instance for the running app. Tests can inject their own via
// the factory below, so this is created lazily to avoid coupling module load to
// a fully-populated config.
let sharedClient = null;
function client() {
  if (!sharedClient) sharedClient = buildClient();
  return sharedClient;
}

/**
 * Normalize a successful Meta send response (design §5.1).
 *
 * Meta returns `{ messages: [ { id: "wamid.XXXX" } ] }`. We surface the first
 * `wamid`; `raw` keeps the original body for auditing.
 *
 * @param {object} data response body
 * @returns {{ ok: true, wamid: string|null, raw: object }}
 */
function normalizeSuccess(data) {
  const wamid =
    data &&
    Array.isArray(data.messages) &&
    data.messages[0] &&
    data.messages[0].id
      ? data.messages[0].id
      : null;

  return { ok: true, wamid, raw: data };
}

/**
 * Normalize a Meta error payload (design §5.3) into a stored, human-readable
 * shape (NFR-2).
 *
 * Meta error shape:
 *   { error: { message, code, error_data: { details }, fbtrace_id } }
 *
 * We map:
 *   - code   → error.code (numeric Meta code) as string, or a fallback
 *   - title  → error.message (short human-readable summary)
 *   - detail → error.error_data.details when present, else error.message
 *
 * @param {object} data error response body (may be undefined for network errs)
 * @param {string} [fallbackTitle] used when no Meta error object is present
 * @returns {{ ok: false, code: string|null, title: string, detail: string, raw: object|null }}
 */
function normalizeError(data, fallbackTitle) {
  const err = data && data.error;

  if (err) {
    const code = err.code !== undefined && err.code !== null ? String(err.code) : null;
    const title = err.message || fallbackTitle || 'WhatsApp API error';
    const detail =
      (err.error_data && err.error_data.details) || err.message || title;
    return { ok: false, code, title, detail, raw: data };
  }

  // No structured Meta error (e.g. network/timeout, or an unexpected body).
  const title = fallbackTitle || 'WhatsApp API error';
  return { ok: false, code: null, title, detail: title, raw: data || null };
}

/**
 * Translate a thrown axios error into a normalized failure.
 *
 * Covers three cases without ever leaking the token:
 *   - Meta responded with an error body → normalize it (design §5.3).
 *   - Request timed out (`ECONNABORTED`) → timeout message.
 *   - No response (network failure) → generic network message.
 *
 * @param {any} error thrown by axios
 * @returns {{ ok: false, code: string|null, title: string, detail: string, raw: object|null }}
 */
function normalizeThrown(error) {
  // Meta returned a non-2xx with a body.
  if (error && error.response && error.response.data) {
    return normalizeError(error.response.data, 'WhatsApp API request failed');
  }

  // Timeout — axios sets code 'ECONNABORTED' when the configured timeout hits.
  if (error && error.code === 'ECONNABORTED') {
    return {
      ok: false,
      code: 'ETIMEDOUT',
      title: 'Request to WhatsApp timed out',
      detail: `The request exceeded the ${config.meta.timeoutMs}ms timeout.`,
      raw: null,
    };
  }

  // Any other network-level failure (DNS, connection refused, no response).
  return {
    ok: false,
    code: error && error.code ? String(error.code) : null,
    title: 'Could not reach WhatsApp API',
    detail:
      error && error.message
        ? String(error.message)
        : 'Network error contacting the WhatsApp API.',
    raw: null,
  };
}

/**
 * POST a message payload to `/messages` and normalize the outcome.
 *
 * @param {object} payload full Cloud API message body
 * @returns {Promise<object>} normalized success or failure
 */
async function postMessage(payload) {
  try {
    const res = await client().post('/messages', payload);
    return normalizeSuccess(res.data);
  } catch (error) {
    return normalizeThrown(error);
  }
}

/**
 * Send a template message (Requirement 5.1, design §5.1).
 *
 * @param {string} to recipient in E.164 without the leading '+' or with it —
 *   Meta accepts the digits; callers pass what they persist.
 * @param {string} name approved template name (e.g. "hello_world")
 * @param {string} lang BCP-47 language code (e.g. "en_US")
 * @param {Array<object>} [components] optional template components
 *   (e.g. body parameters); omitted from the payload when empty.
 * @returns {Promise<{ok:boolean, wamid?:string|null, code?:string|null, title?:string, detail?:string, raw:any}>}
 */
async function sendTemplate(to, name, lang, components) {
  const template = {
    name,
    language: { code: lang },
  };
  if (Array.isArray(components) && components.length > 0) {
    template.components = components;
  }

  const payload = {
    messaging_product: MESSAGING_PRODUCT,
    to,
    type: 'template',
    template,
  };

  return postMessage(payload);
}

/**
 * Send a free-text message (Requirement 5.2, design §5.2).
 *
 * Only deliverable inside a 24-hour session window; the caller is responsible
 * for that policy — this method just performs the send.
 *
 * @param {string} to recipient (E.164 digits)
 * @param {string} body message text
 * @returns {Promise<{ok:boolean, wamid?:string|null, code?:string|null, title?:string, detail?:string, raw:any}>}
 */
async function sendText(to, body) {
  const payload = {
    messaging_product: MESSAGING_PRODUCT,
    to,
    type: 'text',
    text: { body },
  };

  return postMessage(payload);
}

module.exports = {
  sendTemplate,
  sendText,
  // Exported for testing / advanced wiring.
  buildClient,
  normalizeSuccess,
  normalizeError,
  normalizeThrown,
};
