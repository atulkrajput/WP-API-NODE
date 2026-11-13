'use strict';

/**
 * Public privacy-policy page used as the Meta app Privacy Policy URL.
 *
 * This controller intentionally has no authentication, database, or Meta API
 * dependencies so Meta can fetch the page anonymously after deployment.
 */
function getPrivacyPolicy(req, res) {
  return res.render('privacy-policy', {
    title: 'Privacy Policy — WhatsApp Messaging',
  });
}

/** Public Terms of Service (Meta app settings: Terms of Service URL). */
function getTerms(req, res) {
  return res.render('terms');
}

/** Public data deletion instructions (Meta app settings: User data deletion). */
function getDataDeletion(req, res) {
  return res.render('data-deletion');
}

module.exports = {
  getPrivacyPolicy,
  getTerms,
  getDataDeletion,
};
