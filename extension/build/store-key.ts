/**
 * Public key of the item published in Chrome Web Store, used only by the
 * **QA** build (`npm run build:qa -w extension` → `dist-qa/`).
 *
 * With this `key` an unpacked copy gets the same ID as the store item, so the
 * OAuth client (tied to that ID) works and QA can run against production while
 * the store reviews a new version. It is NOT secret: Chrome derives the ID from
 * it and anyone with the published extension can read it (Developer Dashboard →
 * Package → "Public key", without the PEM header/footer).
 *
 * The production build (`dist/`, the one uploaded to the store) must never
 * carry `key`: the store rejects it. `scripts/build.ts` checks both things.
 *
 * Kept free of `@timetracking/shared` imports (see `manifest.ts`).
 */
import { createHash } from 'node:crypto';

/** SPKI DER, base64, one line. */
export const STORE_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8ZTJsw8umfp5rcqH7Q3hdDrvvQQZRuTZw5ZmWqLGw+napkuanbm70EHb6v+kpND5CtugkFCErsb5wH7PiwpTBPZPG7ZDrUt/0llzTMJsenoYXVe5dhrbPxaGUrLuoXxDP5QcDwadkFi4BL5oAJvXl6q+2bS8wUpwho9Z8vpxNASV73/eH29M5dzPbwb+JdYfUDT51GW8C6ofsVP4v/T6RUHhORbX7matjDRxFyPBLBZPJC/VZYmiKr49Rh/dCBTQ5LeF0igiWGk+CJ7Yzd1UT6CDgqDp1WN2clVBj4iAO62W+Us5RpaBUedggWFKuCSjTao4eGki0cmDqMa3gwk91wIDAQAB';

/** ID of the Chrome Web Store item (must match {@link STORE_PUBLIC_KEY}). */
export const STORE_EXTENSION_ID = 'egaklokkbnbnccnjicaahaifnkaeobfj';

/**
 * Extension ID Chrome derives from a manifest `key`: SHA-256 of the DER bytes,
 * first 32 hex digits, each digit 0-f mapped to a-p.
 */
export function extensionIdFromKey(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64.replace(/\s+/g, ''), 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(c, 16))).join('');
}
