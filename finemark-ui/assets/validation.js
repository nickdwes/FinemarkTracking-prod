/**
 * Shared phone/email validation — mirrors finemark-backend/src/utils/validators.ts
 * exactly (same regex). Validates Kenyan mobile numbers and standard emails.
 * Distinct from the older normalisePhoneKe() helpers (crm-quote-detail.html,
 * crm-customer-360.html, crm-leads.html), which strip/prefix but never reject
 * malformed input.
 */
(function (global) {
  const KE_PHONE_RE = /^(?:\+254|254|0)(?:7\d{8}|1\d{8})$/;
  const EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  function isValidKePhone(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    return KE_PHONE_RE.test(raw.trim().replace(/[\s-]/g, ''));
  }

  function normalizeKePhoneStrict(raw) {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.trim().replace(/[\s-]/g, '');
    if (!KE_PHONE_RE.test(cleaned)) return null;
    const digits = cleaned.replace(/^\+/, '');
    return digits.startsWith('254') ? digits : '254' + digits.slice(1);
  }

  function isValidEmail(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    return EMAIL_RE.test(raw.trim());
  }

  // Kenyan vehicle registration — checks plate *shape*, not an exhaustive
  // prefix list (NTSA issues new special-series prefixes faster than any
  // fixed list can track; a previous per-prefix regex kept rejecting real
  // plates like "KTCC212Q"). Tractors/tuktuks/special equipment often aren't
  // registered under the standard NTSA scheme at all, so those categories
  // get a much looser "looks like a real identifier" check instead.
  // Whitespace is stripped before testing (real plates like "GK A001B" put a
  // letter *after* a space, which a single letter-block-then-space pattern
  // can't express) — matches finemark-backend/src/utils/validators.ts exactly.
  const KE_REG_STANDARD_RE = /^\d{0,3}[A-Z]{1,6}\d{1,6}[A-Z]{0,2}$/i;
  const KE_REG_LETTERS_ONLY_RE = /^(SNA|SS|CJ)$/i;
  const KE_REG_LOOSE_RE = /^[A-Z0-9][A-Z0-9\s-]{2,16}[A-Z0-9]$/i;
  const LOOSE_REG_CATEGORIES = new Set(['tractor', 'special_equipment', 'tuktuk']);

  function isValidKeRegistration(raw, category) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const v = raw.trim();
    if (category && LOOSE_REG_CATEGORIES.has(category)) return KE_REG_LOOSE_RE.test(v);
    const compact = v.replace(/\s+/g, '');
    return KE_REG_STANDARD_RE.test(compact) || KE_REG_LETTERS_ONLY_RE.test(compact);
  }

  // Attaches a live red-border + hint-message validator to an <input>. Only
  // flags the field once the user has typed something and moved on/paused —
  // never shows an error against an empty, untouched field.
  function attachLiveValidator(input, validatorFn, message) {
    if (!input) return;
    let hint = input.parentElement && input.parentElement.querySelector('.fm-validation-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'fm-validation-hint text-xs text-red-600 mt-1 hidden';
      hint.textContent = message;
      input.insertAdjacentElement('afterend', hint);
    }
    const check = () => {
      const val = input.value || '';
      const bad = val.trim() && !validatorFn(val);
      input.classList.toggle('border-red-400', !!bad);
      input.classList.toggle('ring-red-200', !!bad);
      hint.classList.toggle('hidden', !bad);
    };
    input.addEventListener('input', check);
    input.addEventListener('blur', check);
  }

  global.FinemarkValidation = {
    KE_PHONE_RE,
    EMAIL_RE,
    isValidKePhone,
    isValidEmail,
    normalizeKePhoneStrict,
    attachLiveValidator,
    isValidKeRegistration,
  };
})(window);
