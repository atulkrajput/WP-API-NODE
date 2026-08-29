'use strict';

/**
 * Auth controller (Requirement 1).
 *
 * Handles the login form (GET), credential verification (POST), and logout
 * (POST). Passwords are verified against the stored bcrypt hash via `bcryptjs`;
 * plaintext passwords are never stored or logged (Requirement 1.5).
 *
 * Session model: on successful login we record `req.session.adminId` and
 * `req.session.username`. The `requireAuth` middleware treats a set `adminId`
 * as an authenticated session.
 */

const bcrypt = require('bcryptjs');

const adminModel = require('../models/admin');

/**
 * GET /login — render the login form.
 * If already authenticated, redirect straight to the dashboard.
 */
function getLogin(req, res) {
  if (req.session && req.session.adminId) {
    return res.redirect('/');
  }
  return res.render('login', { error: null, username: '' });
}

/**
 * POST /login — verify credentials and start a session (Requirement 1.2, 1.3).
 *
 * On success: create the session and redirect to `/`.
 * On failure: re-render the login page with a generic error and NO session.
 */
async function postLogin(req, res, next) {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    // Generic error avoids leaking whether the username exists.
    const rejectMessage = 'Invalid username or password.';

    const admin = await adminModel.findByUsername(username);

    // Always run a compare (even with a dummy hash when the user is missing)
    // to keep timing roughly constant and avoid user enumeration.
    const hash = admin ? admin.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!admin || !ok) {
      return res.status(401).render('login', {
        error: rejectMessage,
        username,
      });
    }

    // Prevent session fixation: regenerate the session id on privilege change.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      req.session.username = admin.username;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.redirect('/');
      });
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /logout — destroy the session and redirect to `/login` (Requirement 1.4).
 */
function postLogout(req, res, next) {
  if (!req.session) {
    return res.redirect('/login');
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    // Clear the session cookie in the browser too.
    res.clearCookie('connect.sid');
    return res.redirect('/login');
  });
}

module.exports = { getLogin, postLogin, postLogout };
