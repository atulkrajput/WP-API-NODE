'use strict';

/**
 * Authentication middleware (Requirement 1.1).
 *
 * `requireAuth` guards protected routes. If the request has no authenticated
 * session it redirects to `/login`; otherwise it passes control to the next
 * handler. A session is considered authenticated when `req.session.adminId`
 * is set (see the auth controller).
 */

/**
 * Guard a route so only an authenticated admin may reach it.
 * Redirects unauthenticated requests to `/login`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  // Surface a one-shot flash so the login page can explain the redirect. This
  // does not change the redirect behavior (still 302 → /login); it degrades
  // gracefully when the flash helper isn't mounted.
  if (typeof req.flash === 'function') {
    req.flash('warning', 'Please log in to continue.');
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
