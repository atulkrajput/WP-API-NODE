'use strict';

/**
 * Raw-body capture middleware for the webhook route (design §5.5, §7).
 *
 * Meta signs the webhook POST with `X-Hub-Signature-256 = 'sha256=' +
 * HMAC_SHA256(appSecret, rawBody)`. To verify that signature we must hash the
 * EXACT bytes Meta sent — a re-serialized `JSON.stringify(req.body)` can differ
 * (key order, spacing, unicode escaping) and would break the check.
 *
 * `express.json` supports a `verify` hook that runs with the raw Buffer before
 * the body is parsed. We use it to stash the raw bytes on `req.rawBody`, then
 * let express.json parse the JSON as usual so the controller still gets
 * `req.body`. This parser is mounted ONLY on `/webhook`, BEFORE the global
 * `express.json()` in app.js, so the rest of the app is unaffected.
 *
 * @returns {import('express').RequestHandler}
 */
function rawBodyParser() {
  const express = require('express');
  return express.json({
    // Accept any content type Meta may use; the webhook body is always JSON.
    type: () => true,
    verify: (req, _res, buf) => {
      // Preserve the exact received bytes for signature verification.
      req.rawBody = buf && buf.length ? Buffer.from(buf) : Buffer.alloc(0);
    },
  });
}

module.exports = { rawBodyParser };
