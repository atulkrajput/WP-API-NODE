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

module.exports = {
  getPrivacyPolicy,
};
