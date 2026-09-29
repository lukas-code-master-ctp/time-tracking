/**
 * Post-build step (run by `npm run build`, before check-build): writes
 * `dist/privacidad.html`, the privacy policy already rendered in the HTML.
 *
 * `/privacidad` is the Chrome Web Store "privacy policy URL". The SPA only
 * shows it after running JS, so reviewers or robots without JS would see an
 * empty page. This file is `dist/index.html` (same CSS and JS bundles) with
 * the markup of `PrivacyPage` inside `#root` and its title. Vercel and
 * Firebase Hosting rewrite `/privacidad` to it (see vercel.json and
 * firebase.json); when JS runs, the SPA renders the same page on top.
 *
 * The content comes from the React component itself (rendered with Vite's
 * SSR loader), so there is a single source and no copy to keep in sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { createServer } from 'vite';

const PORTAL = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PORTAL, 'dist');

const vite = await createServer({
  configFile: join(PORTAL, 'vite.config.ts'),
  mode: 'production',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
try {
  // Only the component goes through Vite (TSX, `@timetracking/shared` alias);
  // react and react-router stay external, so both sides share one instance.
  const page = await vite.ssrLoadModule('/src/pages/PrivacyPage.tsx');
  const markup = renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [page.PRIVACY_PATH] }, createElement(page.PrivacyPage)),
  );

  const index = readFileSync(join(DIST, 'index.html'), 'utf8');
  const root = '<div id="root"></div>';
  if (!index.includes(root)) throw new Error(`dist/index.html no contiene ${root}`);
  const title = String(page.PRIVACY_TITLE).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = index
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
    .replace(root, () => `<div id="root">${markup}</div>`);
  writeFileSync(join(DIST, 'privacidad.html'), html);
  console.log('Política de privacidad prerenderizada en dist/privacidad.html.');
} finally {
  await vite.close();
}
