'use strict';

const path = require('path');

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const config = require('./config');
const routes = require('./routes');
const { csrfProtection } = require('./middleware/csrf');
const { flash } = require('./middleware/flash');
const { rawBodyParser } = require('./middleware/rawBody');
const webhookController = require('./controllers/webhook');

/**
 * Build and configure the Express application.
 *
 * Task 3 wires session management, CSRF protection, EJS views, and the auth /
 * dashboard routes on top of the baseline scaffold. Later tasks add validation,
 * messaging, bulk, and webhook routes to `src/routes/index.js`.
 */
function createApp() {
  const app = express();

  // Trust the reverse proxy (Hostinger / any TLS terminator) so secure cookies
  // and protocol detection work behind HTTPS.
  app.set('trust proxy', 1);

  // View engine: EJS (design §2). Views live in src/views.
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Security headers.
  app.use(helmet());

  // Request logging (quiet during tests).
  if (config.env !== 'test') {
    app.use(morgan(config.isProd ? 'combined' : 'dev'));
  }

  // --- Webhook (Meta callbacks; public, design §4/§5.4/§5.5) ---
  // Mounted BEFORE the global json/urlencoded parsers, session, and CSRF because:
  //   1. POST /webhook needs the RAW request body to verify the Meta signature
  //      (X-Hub-Signature-256), so a raw-body parser is scoped to /webhook only.
  //   2. Meta's callbacks carry no session cookie or CSRF token, so the webhook
  //      must not sit behind session-auth or CSRF middleware.
  // GET  /webhook → verification handshake (hub.challenge / verify token).
  // POST /webhook → signature-verified status callbacks.
  app.get('/webhook', webhookController.getVerify);
  app.post('/webhook', rawBodyParser(), webhookController.postCallback);

  // Body / cookie parsing.
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Server-side sessions (Requirement 1.2). httpOnly + secure cookies; the
  // secure flag follows config so local dev over HTTP still works while prod
  // (behind HTTPS on Hostinger) gets secure cookies.
  app.use(
    session({
      name: 'connect.sid',
      secret: config.session.secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.session.secure,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
      },
    })
  );

  // CSRF protection for all state-changing routes (Requirement 1.6). Must come
  // after session + body parsing so it can read the token from the session and
  // the submitted form field.
  app.use(csrfProtection());

  // Session-backed flash messaging (Task 13). Mounted after session so it can
  // read/write req.session.flash; publishes res.locals.flash for every render
  // and clears it so each message shows exactly once. Provides req.flash().
  app.use(flash());

  // Liveness probe — no auth, returns 200 JSON.
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      env: config.env,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Application routes (auth + dashboard for now).
  app.use('/', routes);

  // Centralized error handler. CSRF failures surface here as 403; everything
  // else is a 500. Never leak stack traces to the client (NFR-2).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = res.statusCode && res.statusCode >= 400 ? res.statusCode : 500;
    if (config.env !== 'test') {
      // eslint-disable-next-line no-console
      console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
    }
    res.status(status);
    if (req.accepts('html')) {
      return res.send(
        `<!doctype html><html><body><h1>${status}</h1><p>${
          status === 403 ? 'Request rejected.' : 'Something went wrong.'
        }</p></body></html>`
      );
    }
    return res.json({ error: status === 403 ? 'forbidden' : 'internal_error' });
  });

  return app;
}

module.exports = createApp;
