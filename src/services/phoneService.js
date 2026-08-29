'use strict';

/**
 * PhoneService — Tier A structural / format validation (Requirement 2).
 *
 * Wraps `libphonenumber-js` to turn a raw phone-number string (with an optional
 * default country for numbers written in national format) into a normalized
 * result the controller can persist and render.
 *
 * IMPORTANT: this is **structural** validation only. A valid result here means
 * the number is well-formed for its region — it does NOT mean the number is
 * reachable on WhatsApp. Deliverability is Tier B (Requirement 3) and can only
 * be confirmed by a real send. Callers must never present a Tier A pass as a
 * deliverability guarantee (Requirement 2.5).
 */

const {
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} = require('libphonenumber-js');

/** Human-readable label attached to a valid Tier A result (Requirement 2.2). */
const TIER_A_VALID_LABEL = 'Format valid (Tier A — not a deliverability check)';

/**
 * Map a `validatePhoneNumberLength` code (or thrown ParseError) to a clear,
 * user-facing reason (Requirement 2.3).
 *
 * @param {string} code
 * @returns {string}
 */
function reasonForCode(code) {
  switch (code) {
    case 'INVALID_COUNTRY':
      return 'Invalid or missing country code — provide a default country or use international (+…) format.';
    case 'NOT_A_NUMBER':
      return 'Input does not contain a valid phone number.';
    case 'TOO_SHORT':
      return 'Number is too short.';
    case 'TOO_LONG':
      return 'Number is too long.';
    case 'INVALID_LENGTH':
      return 'Number has an invalid length for its country.';
    default:
      return 'Number is not a valid phone number.';
  }
}

/**
 * Parse and validate a phone number's structure (Tier A).
 *
 * @param {string} input raw phone number as typed by the admin
 * @param {string} [defaultCountry] optional ISO-3166 alpha-2 country (e.g. "US")
 *   used to interpret numbers written in national (non-`+`) format.
 * @returns {{
 *   valid: boolean,
 *   e164: string|null,
 *   country: string|null,
 *   type: string|null,
 *   reason: string|null,
 *   label: string|null,
 *   tier: 'A'
 * }}
 */
function parse(input, defaultCountry) {
  const raw = typeof input === 'string' ? input.trim() : '';

  // Empty / non-string input never parses.
  if (!raw) {
    return {
      valid: false,
      e164: null,
      country: null,
      type: null,
      reason: 'No phone number provided.',
      label: null,
      tier: 'A',
    };
  }

  const country =
    typeof defaultCountry === 'string' && defaultCountry.trim()
      ? defaultCountry.trim().toUpperCase()
      : undefined;

  // `parsePhoneNumberFromString` returns undefined (rather than throwing) when
  // the input can't be parsed, so we don't need try/catch here.
  const parsed = parsePhoneNumberFromString(raw, country);

  if (parsed && parsed.isValid()) {
    return {
      valid: true,
      e164: parsed.number, // E.164, e.g. "+15551234567"
      country: parsed.country || null,
      type: parsed.getType() || null, // mobile / fixed_line / etc.
      reason: null,
      label: TIER_A_VALID_LABEL,
      tier: 'A',
    };
  }

  // Not valid — derive the clearest possible reason. `validatePhoneNumberLength`
  // gives us a specific length/country code even when full parsing fails.
  const lengthCheck = validatePhoneNumberLength(raw, country);
  const reason = reasonForCode(lengthCheck || 'INVALID');

  return {
    valid: false,
    // Surface the best-effort E.164 if the number was parseable but not valid
    // (helps the admin see what was interpreted); otherwise null.
    e164: parsed ? parsed.number : null,
    country: parsed && parsed.country ? parsed.country : null,
    type: null,
    reason,
    label: null,
    tier: 'A',
  };
}

module.exports = { parse, TIER_A_VALID_LABEL };
