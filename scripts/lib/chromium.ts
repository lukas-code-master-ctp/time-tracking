/**
 * Locates a Chromium that can load unpacked extensions (Playwright's).
 *
 * Branded Google Chrome ignores `--load-extension` since v137, so the e2e
 * scripts use Playwright's Chromium: `npx playwright install chromium`, any
 * cached `ms-playwright/chromium-*` build, or `SMOKE_CHROMIUM=<path>`.
 * Used by extension/scripts/smoke.ts, portal/e2e/portal.e2e.ts and scripts/.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const EXECUTABLES = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome'];

/** Path to Chromium, or `null` when none is installed. */
export function findChromium(): string | null {
  const fromEnv = process.env.SMOKE_CHROMIUM;
  if (fromEnv) return fromEnv;
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', '.cache'), 'ms-playwright');
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const dir of dirs) {
    for (const exe of EXECUTABLES) {
      const p = join(cache, dir, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export const NO_CHROMIUM =
  'no se encontró Chromium de Playwright. Ejecuta `npx playwright install chromium` o define SMOKE_CHROMIUM.';

/** Path to Chromium; throws with install instructions when none is found. */
export function chromiumPath(): string {
  const p = findChromium();
  if (!p) throw new Error(NO_CHROMIUM);
  return p;
}
