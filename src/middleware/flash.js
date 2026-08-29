'use strict';

/**
 * Flash messaging — lightweight, session-backed, dependency-free (Task 13).
 *
 * A flash message is a one-shot notification stored on the session and shown on
 * the NEXT rendered page, then cleared. It is the standard pattern for surfacing
 * the outcome of a redirect (e.g. "job created", "login required") without a
 * query string.
 *
 * Design choice: rather than pull in `connect-flash`, we implement the same
 * pattern directly against `express-session` (mirrors the in-house CSRF
 * middleware decision). The store is a small array of `{ type, message }`
 * objects on `req.session.flash`.
 *
 * Usage:
 *   - Producing a flash (in a controller, before a redirect):
 *       req.flash('success', 'Job created.');
 *       return res.redirect('/bulk');
 *   - Consuming (automatic): this middleware moves any pending flashes onto
 *     `res.locals.flash` for the current render and clears them from the
 *     session so they show exactly once.
 *
 * `type` is a Bootstrap contextual suffix (success | danger | warning | info).
 * User-facing flash text must be a plain human-readable string — never a stack
 * trace or raw error object (NFR-2).
 */

/** Bootstrap alert types we render; anything else falls back to `info`. */
const KNOWN_TYPES = new Set(['success', 'danger', 'warning', 'info']);

/**
 * Express middleware that wires flash messaging onto the request/response.
 *
 * - Adds `req.flash(type, message)` to enqueue a flash for the next render.
 * - Moves pending flashes from `req.session.flash` to `res.locals.flash`
 *   (an array) for the current render, then clears the session copy so each
 *   flash is shown exactly once.
 *
 * Requires `express-session` to be mounted before it. If there is no session
 * (should not happen on session-backed routes), it degrades gracefully: flashes
 * are simply not persisted across the redirect.
 *
 * @returns {import('express').RequestHandler}
 */
function flash() {
  return function flashMiddleware(req, res, next) {
    // Producer: enqueue a flash for the next render.
    req.flash = function enqueueFlash(type, message) {
      if (!req.session) return;
      if (!Array.isArray(req.session.flash)) {
        req.session.flash = [];
      }
      const t = KNOWN_TYPES.has(type) ? type : 'info';
      req.session.flash.push({ type: t, message: String(message == null ? '' : message) });
    };

    // Consumer: expose the current session's flashes to the view and clear them.
    const pending =
      req.session && Array.isArray(req.session.flash) ? req.session.flash : [];
    res.locals.flash = pending;
    if (req.session && Array.isArray(req.session.flash)) {
      req.session.flash = [];
    }

    return next();
  };
}

module.exports = { flash, KNOWN_TYPES };
