/**
 * Post-build check of portal/dist (run by `npm run build`):
 * - index.html and at least one JS bundle exist.
 * - The production bundle carries no dev-only code (dev login with the fake
 *   Google credential, emulator wiring). That code sits behind `IS_DEV`
 *   (`import.meta.env.DEV`), which Vite replaces with `false` so it is dropped.
 * - Warns while `.env.production` still has placeholders.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const FORBIDDEN = ['Entrar (emulador)', 'email_verified', '127.0.0.1', 'Correo simulado'];

const problems: string[] = [];
if (!existsSync(join(DIST, 'index.html'))) problems.push('falta dist/index.html');
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
