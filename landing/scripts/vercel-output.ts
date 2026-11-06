/**
 * Joins the portal and the landing in one Vercel output (portal/dist), run by the
 * root vercel.json after both builds:
 * - landing/dist → portal/dist/_landing (served for the host www.mipegahr.cl).
 * - portal/dist/index.html → portal/dist/app.html. Vercel serves a file that
 *   exists before applying rewrites, so with an index.html at the root "/" would
 *   always be the portal, also on www. Without it, "/" goes through the rewrites:
 *   www → the landing, any other host → app.html (the portal SPA).
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const PORTAL = at('portal/dist');
const LANDING = at('landing/dist');

if (!existsSync(`${PORTAL}/index.html`) || !existsSync(`${LANDING}/index.html`)) {
  console.error('vercel-output: falta portal/dist/index.html o landing/dist/index.html (corre antes ambos builds)');
  process.exit(1);
}
renameSync(`${PORTAL}/index.html`, `${PORTAL}/app.html`);
rmSync(`${PORTAL}/_landing`, { recursive: true, force: true });
cpSync(LANDING, `${PORTAL}/_landing`, { recursive: true });
console.log('vercel-output: portal/dist/app.html + portal/dist/_landing listos');
