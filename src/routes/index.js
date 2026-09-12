'use strict';

/**
 * Application routes (design §4).
 *
 * Task 3 wires the authentication surface and the protected dashboard:
 *   GET  /login   (no auth)  → login form
 *   POST /login   (no auth)  → authenticate
 *   POST /logout  (auth)     → destroy session
 *   GET  /        (auth)     → dashboard
 *
 * Later tasks add validation, messaging, bulk, and webhook routes here.
 * All state-changing routes are protected by the CSRF middleware mounted in
 * `app.js`, so the POST handlers below inherit token verification.
 */

const path = require('path');

const express = require('express');
const multer = require('multer');

const config = require('../config');
const authController = require('../controllers/auth');
const validationController = require('../controllers/validation');
const messageController = require('../controllers/message');
const bulkController = require('../controllers/bulk');
const dashboardController = require('../controllers/dashboard');
const privacyController = require('../controllers/privacy');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// --- CSV upload (bulk validation, Task 9 / Requirement 4) ---
// Memory storage: the CSV is parsed straight from a buffer, nothing hits disk
// (no temp-file cleanup needed, safer on shared Hostinger hosting).
//   - `limits.fileSize` enforces the configurable size cap (Requirement 4.3);
//     an oversized file makes multer raise a MulterError('LIMIT_FILE_SIZE').
//   - `fileFilter` rejects anything that is not a CSV by MIME type or by the
//     .csv extension (browsers report CSVs inconsistently: text/csv,
//     application/vnd.ms-excel, application/octet-stream, …) (Requirement 4.3).
const CSV_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers send this for .csv
]);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = CSV_MIME_TYPES.has((file.mimetype || '').toLowerCase());
    const extOk = ext === '.csv';
    // Require a .csv extension AND an acceptable MIME type. If the MIME is a
    // generic fallback (octet-stream) we still trust the .csv extension.
    if (extOk && mimeOk) {
      return cb(null, true);
    }
    const err = new Error(
      'Only .csv files are accepted. Please upload a comma-separated values file.'
    );
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  },
}).single('file');

/**
 * Wrap the multer middleware so file-type / size errors become clean HTTP 400
 * JSON responses instead of bubbling to the generic 500 error handler
 * (Requirement 4.3 — reject with a clear error).
 */
function handleCsvUpload(req, res, next) {
  csvUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        ok: false,
        error: 'file_too_large',
        message: `File exceeds the ${config.upload.maxBytes}-byte upload limit.`,
      });
    }
    if (err.code === 'INVALID_FILE_TYPE') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_file_type',
        message: err.message,
      });
    }
    return next(err);
  });
}

// --- Public policy ---
// Meta requires a publicly reachable Privacy Policy URL. Keep this route
// outside the authenticated surface so Meta and unauthenticated visitors can
// load it without a session or CSRF token.
router.get('/privacy-policy', privacyController.getPrivacyPolicy);

// --- Auth (public) ---
router.get('/login', authController.getLogin);
router.post('/login', authController.postLogin);

// --- Auth (protected) ---
router.post('/logout', requireAuth, authController.postLogout);

// --- Dashboard (protected) ---
// GET / → summary dashboard: recent validations, recent messages, active bulk
//   jobs (Task 13). The dashboard controller fetches the summary data with
//   per-panel error isolation (NFR-2). Auth is preserved via requireAuth.
router.get('/', requireAuth, dashboardController.getDashboard);

// --- Validation (protected, design §4) ---
// GET  /validate         → validation page
// POST /validate/single  → Tier A format check (JSON). State-changing (persists
//   a validation_results row) so it inherits CSRF protection from app.js and is
//   guarded by requireAuth.
// POST /validate/deliverability → Tier B probe send (Requirement 3, design §4).
//   Runs Tier A first; on valid format performs a REAL send via WhatsAppService
//   using the probe template and persists a validation_results row
//   (check_type='deliverability'). State-changing, so it inherits CSRF
//   protection from app.js and is guarded by requireAuth.
router.get('/validate', requireAuth, validationController.getValidatePage);
router.post('/validate/single', requireAuth, validationController.postValidateSingle);
router.post(
  '/validate/deliverability',
  requireAuth,
  validationController.postValidateDeliverability
);

// POST /validate/bulk — CSV upload → Tier A report (Requirement 4).
//
// CSRF + multipart ordering (documented decision):
//   The global csrfProtection() middleware in app.js runs BEFORE this route and
//   reads the token from req.body._csrf / req.query._csrf / the x-csrf-token
//   header. At that point multer has NOT yet parsed the multipart body, so a
//   `_csrf` FORM field would be invisible. We therefore require the CSRF token
//   to be sent as the `x-csrf-token` HEADER for this upload (both the browser
//   fetch() in bulk-validate.ejs and the tests do this). requireAuth then guards
//   access, and handleCsvUpload (multer) parses the file with a size limit and
//   CSV MIME/extension guard before the controller runs.
router.get('/validate/bulk', requireAuth, validationController.getBulkPage);
router.post(
  '/validate/bulk',
  requireAuth,
  handleCsvUpload,
  validationController.postValidateBulk
);

// --- Single message send (protected, design §4, Requirement 5) ---
// GET  /messages              → single-send page (template/text toggle)
// POST /messages/single       → Tier A check → WhatsAppService → persist row.
//   State-changing, so it inherits CSRF protection from app.js and requireAuth.
// GET  /messages/:id/status   → JSON status for polling (Req 5.6)
router.get('/messages', requireAuth, messageController.getMessagesPage);
router.post('/messages/single', requireAuth, messageController.postSingle);
router.get('/messages/:id/status', requireAuth, messageController.getStatus);

// --- Bulk send job creation (protected, design §4, Requirement 6.1/6.2) ---
// GET  /bulk → list existing jobs + the create form (template, language,
//   variable mapping, phone column, default country).
// POST /bulk → parse the recipient CSV, run Tier A per row, resolve per-row
//   template variables from the mapping, and enqueue the job (creates
//   bulk_jobs + bulk_job_items, invalid rows → skipped_invalid, job set
//   running). No sending happens here — that is Task 11 (the worker).
//
// CSRF + multipart ordering: identical to /validate/bulk (Task 9). The global
// CSRF middleware runs BEFORE multer parses the multipart body, so the token is
// sent via the `x-csrf-token` HEADER (the view's fetch() and the tests do this).
// requireAuth guards access; handleCsvUpload (multer) parses the file with the
// size + CSV MIME/extension guard before the controller runs.
router.get('/bulk', requireAuth, bulkController.getBulkPage);
router.post('/bulk', requireAuth, handleCsvUpload, bulkController.postCreateJob);

// --- Bulk job history & progress (protected, design §4, Requirement 8) ---
// GET /bulk/:id          → job detail: per-item status, recipient, wamid, and
//   failure reason (Req 8.2), with an optional `?status=` filter (Req 8.4) and
//   a seeded live progress snapshot (Req 8.3).
// GET /bulk/:id/progress → JSON live X-of-Y counts for client polling (Req 8.3).
// Both are read-only GETs guarded by requireAuth. The `/progress` route is
// registered before `/:id` is irrelevant here (distinct suffixes), but keeping
// the detail route first mirrors the design §4 ordering.
router.get('/bulk/:id', requireAuth, bulkController.getJobDetail);
router.get('/bulk/:id/progress', requireAuth, bulkController.getJobProgress);

// POST /bulk/:id/retry-failed → re-queue a job's failed items (Requirement 8.5,
//   optional stretch, gated behind a button in the detail view). Sets the job
//   running again so the worker resumes it; the BullMQ path (when
//   QUEUE_DRIVER=bullmq) honors the same contract.
//
// CSRF: this is a plain state-changing POST (JSON / urlencoded body, NOT
// multipart), so the global CSRF middleware in app.js reads the normal `_csrf`
// body field (or x-csrf-token header) — no multer-ordering workaround needed
// unlike POST /bulk and POST /validate/bulk. requireAuth guards access.
router.post('/bulk/:id/retry-failed', requireAuth, bulkController.postRetryFailed);

module.exports = router;
