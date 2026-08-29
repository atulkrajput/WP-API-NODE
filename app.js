'use strict';

/**
 * Root entry point for Passenger-based hosting (Hostinger).
 *
 * Hostinger's Node.js hosting runs the app under Phusion Passenger, which loads
 * a startup file at the application root (defaulting to `app.js`). Passenger
 * *requires* this file rather than executing it directly, so the real server
 * must call `listen()` unconditionally on load.
 *
 * This thin shim simply loads `src/server.js`, which starts the HTTP server
 * (calling app.listen) as a side effect and exports the running server
 * instance. Keeping the real app under `src/` unchanged means local dev
 * (`npm start` -> `node src/server.js`) and tests are unaffected.
 */

module.exports = require('./src/server');
