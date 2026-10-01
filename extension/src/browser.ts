/**
 * Which Chromium browser runs the extension (used to pick the Google sign-in
 * method; see background/auth.ts). Safe in the service worker and the popup.
 */

/** `chrome.identity.getAuthToken` exists (Chrome; Edge/Brave/Opera may define it but it does not work). */
export function hasGetAuthToken(): boolean {
  return typeof globalThis.chrome?.identity?.getAuthToken === 'function';
}

/**
 * Google Chrome itself (its User-Agent Client Hints brand). Edge, Opera and
 * Brave report their own brand; a browser that hides it (some Vivaldi
 * versions) counts as Chrome, which only means the Chrome message is shown
 * when it has no Google account.
 */
export function isGoogleChrome(): boolean {
  const brands = (globalThis.navigator as (Navigator & { userAgentData?: { brands?: { brand: string }[] } }) | undefined)?.userAgentData
    ?.brands;
  if (!Array.isArray(brands)) return true;
  return brands.some((b) => b.brand === 'Google Chrome');
}

/** The popup shows a hint when sign-in will open Google's account chooser instead of Chrome's own flow. */
export function usesGoogleAccountChooser(): boolean {
  return !hasGetAuthToken() || !isGoogleChrome();
}
