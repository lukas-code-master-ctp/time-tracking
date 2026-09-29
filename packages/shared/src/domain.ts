/** Email / Workspace domain checks. */

import { emailKey } from './collections.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** Maximum number of allowed Workspace domains (`config/org.allowedDomains`). */
export const MAX_ALLOWED_DOMAINS = 10;

/** Syntactically valid lowercase domain (`empresa.cl`, `mail.empresa.com`). */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercase, trimmed domain without a leading `@`. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

/** True when `domain` (already normalized) is a syntactically valid domain. */
export function isValidDomain(domain: string): boolean {
  return typeof domain === 'string' && DOMAIN_RE.test(domain);
}

/**
 * Normalizes a list of domains: lowercase, trimmed, without `@`, without
 * empties or duplicates, preserving the original order. Non-strings are dropped.
 */
export function normalizeDomainList(domains: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const d of domains) {
    if (typeof d !== 'string') continue;
    const n = normalizeDomain(d);
    if (n) seen.add(n);
  }
  return [...seen];
}

/**
 * Parses a comma/semicolon/whitespace separated list of domains
 * (`"impulseai.cl, @CompraTuParcela.cl"` → `['impulseai.cl', 'compratuparcela.cl']`).
 */
export function parseDomainList(value: string | undefined | null): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return normalizeDomainList(value.split(/[\s,;]+/));
}

/** Returns the lowercase domain of an email, or null if it is not an email. */
export function emailDomain(email: string): string | null {
  if (typeof email !== 'string') return null;
  const e = emailKey(email);
  if (!EMAIL_RE.test(e)) return null;
  return e.slice(e.indexOf('@') + 1);
}

/**
 * True when `email` belongs exactly to one of the allowed domains
 * (case-insensitive). Subdomains are NOT accepted (`a@x.compratuparcela.cl`
 * is rejected), nor are look-alike suffixes (`a@evilcompratuparcela.cl`).
 */
export function isAllowedEmail(email: string, domains: string | readonly string[]): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const list: readonly unknown[] = typeof domains === 'string' ? [domains] : Array.isArray(domains) ? domains : [];
  return normalizeDomainList(list).includes(domain);
}

/**
 * Human-readable list for messages in Spanish:
 * `['a.cl']` → `@a.cl`, `['a.cl', 'b.cl']` → `@a.cl o @b.cl`,
 * `['a.cl', 'b.cl', 'c.cl']` → `@a.cl, @b.cl o @c.cl`.
 */
export function formatDomains(domains: readonly string[]): string {
  const list = normalizeDomainList(domains).map((d) => `@${d}`);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} o ${list[list.length - 1]}`;
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
