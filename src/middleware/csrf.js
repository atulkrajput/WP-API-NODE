'use strict';

/**
 * CSRF protection — session-based synchronizer token pattern (Requirement 1.6).
 *
 * Design choice: the well-known `csurf` package is deprecated and unmaintained.
 * Rather than pull in another third-party dependency, we implement the classic
 * **synchronizer token pattern** directly against `express-session`:
 *
 *   1. A cryptographically-random token is generated once per session and kept
 *      server-side in `req.session.csrfToken`.
 *   2. The token is exposed to templates via `res.locals.csrfToken` so every
 *      form can embed it in a hidden `_csrf` field.
 *   3. On every state-changing request (POST/PUT/PATCH/DELETE) the submitted
 *      token (form field, query, or `x-csrf-token` header) is compared against
 *      the session token using a constant-time comparison.
 *
 * Because the expected token lives in the server-side session (not a
 * client-readable cookie), an attacker on another origin cannot read it, which
 * is what defeats cross-site request forgery. This is dependency-free, easy to
 * reason about, and sufficient for a single-admin MVP.
 */

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

/** Generate a new random CSRF token (hex string). */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** Constant-time string comparison that tolerates length mismatches. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Pull the submitted token from body, query, or header. */
function tokenFromRequest(req) {
  return (
    (req.body && (req.body._csrf || req.body.csrfToken)) ||
    (req.query && req.query._csrf) ||
    req.get('x-csrf-token') ||
    req.get('csrf-token') ||
    null
  );
}

/**
 * Express middleware implementing the synchronizer token pattern.
 *
 * - Ensures a per-session token exists and publishes it on `res.locals`.
 * - Validates the token on state-changing requests, rejecting mismatches 403.
 *
 * Requires `express-session` to be mounted before it.
 *
 * @returns {import('express').RequestHandler}
 */
function csrfProtection() {
  return function csrf(req, res, next) {
    if (!req.session) {
      return next(new Error('csrfProtection requires session middleware'));
    }

    // Ensure a token exists for this session.
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateToken();
    }

    // Expose to views and provide an accessor for programmatic use.
    res.locals.csrfToken = req.session.csrfToken;
    req.csrfToken = () => req.session.csrfToken;

    // Safe (read-only) methods do not need a token.
    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    const submitted = tokenFromRequest(req);
    if (safeEqual(submitted, req.session.csrfToken)) {
      return next();
    }

    res.status(403);
    return next(new Error('Invalid CSRF token'));
  };
}

module.exports = { csrfProtection, generateToken };
