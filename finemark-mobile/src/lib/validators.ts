/** Lightweight client-side validators mirroring the web's FinemarkValidation. */

/** Kenyan phone: 07XXXXXXXX / 01XXXXXXXX / +2547XXXXXXXX / 2541XXXXXXXX. */
export function isValidKePhone(v?: string | null): boolean {
  if (!v) return false;
  const s = v.replace(/\s|-/g, '');
  return /^(?:\+?254|0)(?:7|1)\d{8}$/.test(s);
}

export function isValidEmail(v?: string | null): boolean {
  if (!v) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** Loose KE registration check (backend does the authoritative, category-aware check). */
export function isValidKeRegistration(v?: string | null): boolean {
  if (!v) return false;
  const s = v.trim().toUpperCase();
  // Standard KXX 123X, GK/CD diplomatic, and looser plant/tractor forms.
  return /^[A-Z]{1,3}\s?\d{1,4}\s?[A-Z]?$/.test(s) || /^(GK|CD)\s?[A-Z]?\s?\d{1,4}[A-Z]?$/.test(s);
}
