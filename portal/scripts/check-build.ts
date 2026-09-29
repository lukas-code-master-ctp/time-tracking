/**
 * Post-build check of portal/dist (run by `npm run build`):
 * - index.html and at least one JS bundle exist.
 * - The production bundle carries no dev-only code (dev login with the fake
 *   Google credential, emulator wiring). That code sits behind `IS_DEV`
 *   (`import.meta.env.DEV`), which Vite replaces with `false` so it is dropped.
 * - dist/privacidad.html (scripts/prerender-privacy.ts) carries the policy
 *   already rendered, readable without JS (Chrome Web Store privacy URL), and
 *   vercel.json / firebase.json rewrite `/privacidad` to it before the SPA catch-all.
 * - Warns while `.env.production` still has placeholders.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const FORBIDDEN = ['Entrar (emulador)', 'email_verified', '127.0.0.1', 'Correo simulado'];

const problems: string[] = [];
if (!existsSync(join(DIST, 'index.html'))) problems.push('falta dist/index.html');
const PRIVACY_HTML = join(DIST, 'privacidad.html');
if (!existsSync(PRIVACY_HTML)) problems.push('falta dist/privacidad.html (prerender de la política de privacidad)');
else {
  const privacy = readFileSync(PRIVACY_HTML, 'utf8');
  for (const s of ['<title>Política de privacidad', '<h1>Política de privacidad</h1>', 'Qué NO se recoge', 'mailto:', '<script type="module"'])
    if (!privacy.includes(s)) problems.push(`dist/privacidad.html no contiene "${s}"`);
}
// Both hostings must serve /privacidad with that file (rewrites apply in order).
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
type Rewrite = { source: string; destination: string };
const hostingRewrites: [string, Rewrite[] | undefined][] = [
  ['vercel.json', JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).rewrites],
  ['firebase.json', JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8')).hosting?.rewrites],
];
for (const [file, rewrites] of hostingRewrites) {
  const first = rewrites?.[0];
  if (first?.source !== '/privacidad' || first.destination !== '/privacidad.html')
    problems.push(`${file}: la primera reescritura debe ser /privacidad → /privacidad.html`);
}
const files = existsSync(DIST) ? readdirSync(DIST, { recursive: true, encoding: 'utf8' }) : [];
const js = files.filter((f) => f.endsWith('.js'));
if (js.length === 0) problems.push('no hay bundles .js en dist');
let placeholders = false;
for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
  const text = readFileSync(join(DIST, f), 'utf8');
  for (const s of FORBIDDEN) if (text.includes(s)) problems.push(`${f} contiene código dev ("${s}")`);
  if (text.includes('REEMPLAZAR_')) placeholders = true;
}
if (problems.length > 0) {
  console.error(`Build del portal inválido:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
if (placeholders) {
  console.warn('Aviso: portal/.env.production aún tiene valores REEMPLAZAR_… (el portal publicado no podrá conectarse).');
}
console.log(`Portal generado en ${DIST} (${js.length} archivos JS).`);
