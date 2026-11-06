/**
 * Post-build check of landing/dist (run by `npm run build`):
 * - index.html, fonts, favicon, og.png, robots.txt and sitemap.xml exist.
 * - Every in-page link (#id) points to an element that exists.
 * - Every local src/href (assets, fonts, icons) exists in dist.
 * - Nothing is loaded from Google Fonts or another CDN.
 * - The root vercel.json serves landing/dist (copied to portal/dist/_landing by
 *   scripts/vercel-output.ts) for the host www.mipegahr.cl, after /privacidad
 *   and before the portal SPA (app.html).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const problems: string[] = [];

for (const f of ['index.html', 'favicon.svg', 'og.png', 'robots.txt', 'sitemap.xml', 'fonts/plus-jakarta-sans-latin.woff2', 'fonts/bricolage-grotesque-latin.woff2'])
  if (!existsSync(join(DIST, f))) problems.push(`falta dist/${f}`);

if (existsSync(join(DIST, 'index.html'))) {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, ref] of html.matchAll(/href="#([^"]+)"/g))
    if (!ids.has(ref)) problems.push(`enlace #${ref} sin destino`);
  for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)) {
    if (url === '/') continue;
    if (!existsSync(join(DIST, url!))) problems.push(`no existe ${url} en dist`);
  }
  if (/fonts\.googleapis|fonts\.gstatic/.test(html)) problems.push('la página pide fuentes a Google Fonts');
  for (const s of ['<html lang="es-CL">', '<title>Mi Pega HR', 'name="description"', 'og:image', 'app.mipegahr.cl/privacidad'])
    if (!html.includes(s)) problems.push(`index.html no contiene "${s}"`);
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
type Rewrite = { source: string; destination: string; has?: { type: string; value: string }[] };
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as { buildCommand?: string; rewrites?: Rewrite[] };
const rw = vercel.rewrites ?? [];
const hostIdx = rw.findIndex((r) => r.has?.some((h) => h.type === 'host' && h.value === 'www.mipegahr.cl') && r.destination === '/_landing/$1');
const spaIdx = rw.findIndex((r) => !r.has && r.destination === '/app.html');
if (spaIdx < 0) problems.push('vercel.json: falta el catch-all del portal → /app.html');
if (hostIdx < 0) problems.push('vercel.json: falta la reescritura del host www.mipegahr.cl → /_landing/$1');
else if (spaIdx >= 0 && spaIdx < hostIdx) problems.push('vercel.json: la reescritura de www.mipegahr.cl debe ir antes del catch-all del portal');
if (!vercel.buildCommand?.includes('landing/scripts/vercel-output.ts')) problems.push('vercel.json: el buildCommand no corre landing/scripts/vercel-output.ts');

if (problems.length) {
  console.error(`check-build: ${problems.length} problema(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-build: dist OK');
