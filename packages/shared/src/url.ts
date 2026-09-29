/** URL helpers. Only http/https pages are recorded, without query or hash. */

function parseHttpUrl(url: string): URL | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed;
}

/**
 * Removes query string, hash and credentials. Returns `null` for anything
 * that is not an http/https URL (chrome://, file://, about:, data:, invalid).
 * Example: `https://user:pw@Docs.Google.com/d/1?x=1#h` -> `https://docs.google.com/d/1`.
 */
export function sanitizeUrl(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/**
 * Domain used for grouping: lowercase hostname without a leading `www.`.
 * The port is not included. Returns `null` for non http/https URLs.
 */
export function domainOf(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  return host.startsWith('www.') && host.length > 4 ? host.slice(4) : host;
}
