'use strict';

const createApp = require('./app');
const config = require('./config');
const { startWorker, stopWorker } = require('./worker/worker');

/**
 * Boot the HTTP server.
 *
 * When the DB queue driver is active (`QUEUE_DRIVER=db`, the default), the
 * background worker is started here: it runs the crash-safe startup reconciler
 * once (Req 6.9) and then schedules node-cron ticks (design §6). Starting the
 * worker is guarded to the server boot path so importing modules / tests never
 * spin up the cron loop.
 */
function start() {
  const app = createApp();

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${config.port} (env: ${config.env})`);
  });

  // Start the background worker for the active queue driver. Fire-and-forget:
  // the reconciler + tick have their own error isolation (NFR-2), so a failure
  // here must not prevent the HTTP server from serving.
  if ((config.queue || {}).driver === 'bullmq') {
    // Optional Redis path (design §6, NFR-6). Lazy-require so the default db
    // install never needs bullmq; a clear error surfaces if it/Redis is absent.
    try {
      // eslint-disable-next-line global-require
      const bullmqDriver = require('./services/queueDriverBullmq');
      bullmqDriver.startWorker();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        'Failed to start BullMQ worker:',
        err && err.message ? err.message : err
      );
    }
  } else {
    startWorker().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to start background worker:', err && err.message ? err.message : err);
    });
  }

  // Graceful shutdown.
  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down...`);
    stopWorker();
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Start the HTTP server on load.
//
// Hostinger's Node.js hosting runs the app under Phusion Passenger, which
// *requires* (loads) the entry file rather than executing it directly. That
// means `require.main === module` is false there, so the old guard prevented
// listen() from ever being called and Passenger timed out ("did not call
// listen() within 3 seconds"). We therefore start unconditionally on load.
//
// This is safe for tests: the test suite imports `./app` (the Express factory)
// directly and never requires this file, so starting here does not spin up a
// server during tests.
const server = start();

// Export the running server (Passenger looks for the app/server export) while
// still allowing `require('./server')` to retrieve the instance if needed.
module.exports = server;
