/** Email / Workspace domain checks. */

import { emailKey } from './collections.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** Lowercase, trimmed domain without a leading `@`. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

/** Returns the lowercase domain of an email, or null if it is not an email. */
export function emailDomain(email: string): string | null {
  if (typeof email !== 'string') return null;
  const e = emailKey(email);
  if (!EMAIL_RE.test(e)) return null;
  return e.slice(e.indexOf('@') + 1);
}

/**
 * True when `email` belongs exactly to `allowedDomain` (case-insensitive).
 * Subdomains are NOT accepted (`a@x.compratuparcela.cl` is rejected), nor are
 * look-alike suffixes (`a@evilcompratuparcela.cl`).
 */
export function isAllowedEmail(email: string, allowedDomain: string): boolean {
  const domain = emailDomain(email);
  const allowed = typeof allowedDomain === 'string' ? normalizeDomain(allowedDomain) : '';
  if (!domain || !allowed) return false;
  return domain === allowed;
}

/** Parses a comma/semicolon/whitespace separated list of emails into unique keys. */
export function parseEmailList(value: string | undefined | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\s,;]+/)) {
    const key = emailKey(raw);
    if (key && EMAIL_RE.test(key)) seen.add(key);
  }
  return [...seen];
}
