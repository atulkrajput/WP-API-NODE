'use strict';

/**
 * Inbox — customer replies and conversation threads, with a free-text reply
 * box while the 24h window is open.
 */

const phoneService = require('../services/phoneService');
const messageService = require('../services/messageService');
const contactModel = require('../models/contact');
const inboundMessageModel = require('../models/inboundMessage');

function parseE164(req) {
  const r = phoneService.parse(String(req.params.e164 || ''));
  return r.valid ? r.e164 : null;
}

const threadUrl = (e164) => `/inbox/${encodeURIComponent(e164)}`;

async function getInbox(req, res, next) {
  try {
    let conversations = [];
    let loadError = null;
    try {
      conversations = await inboundMessageModel.listConversations({ limit: 100 });
    } catch (err) {
      loadError = 'Could not load the inbox. Did you run "npm run migrate"?';
    }
    return res.render('inbox', {
      username: req.session.username,
      conversations: conversations || [],
      loadError,
    });
  } catch (err) {
    return next(err);
  }
}

async function getThread(req, res, next) {
  try {
    const e164 = parseE164(req);
    if (!e164) {
      req.flash('warning', 'Not a valid phone number.');
      return res.redirect('/inbox');
    }
    const [state, items] = await Promise.all([
      contactModel.getState(e164),
      inboundMessageModel.thread(e164, { limit: 200 }),
    ]);
    return res.render('inbox-thread', {
      username: req.session.username,
      e164,
      state,
      items: items || [],
      threadUrl: threadUrl(e164),
    });
  } catch (err) {
    return next(err);
  }
}

async function postReply(req, res, next) {
  try {
    const e164 = parseE164(req);
    if (!e164) return res.redirect('/inbox');
    const body = String((req.body && req.body.body) || '');
    const result = await messageService.sendOne({ mode: 'text', to: e164, body });
    if (result.body.ok) {
      req.flash('success', 'Reply sent.');
    } else {
      const e = result.body.error;
      const detail = (e && typeof e === 'object' && (e.title || e.detail)) || result.body.reason || 'Send failed.';
      req.flash('danger', `Not sent: ${detail}`);
    }
    return res.redirect(threadUrl(e164));
  } catch (err) {
    return next(err);
  }
}

/** Admin override: mark opted out / clear opt-out (e.g. consent given by phone). */
async function postOptOut(req, res, next) {
  try {
    const e164 = parseE164(req);
    if (!e164) return res.redirect('/inbox');
    const optedOut = String(req.body && req.body.optedOut) === '1';
    await contactModel.setOptOut(e164, optedOut);
    req.flash('info', optedOut ? 'Contact opted out. All sends to this number are blocked.' : 'Opt-out cleared.');
    return res.redirect(threadUrl(e164));
  } catch (err) {
    return next(err);
  }
}

module.exports = { getInbox, getThread, postReply, postOptOut };
