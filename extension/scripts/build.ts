/**
 * Builds the extension: `node scripts/build.ts --mode production|development [--watch]`.
 * Output: `dist/` (prod) or `dist-dev/` (dev), loadable with "Load unpacked".
 *
 * Runs with Node's built-in TypeScript type stripping (Node >= 22.18).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { ROOT, outDirOf } from '../build/common.ts';
import { BACKGROUND_FILE, CONTENT_FILE } from '../build/manifest.ts';
import { PARTS, partConfig } from '../build/parts.ts';

const args = process.argv.slice(2);
const modeIdx = args.indexOf('--mode');
const mode = modeIdx >= 0 ? (args[modeIdx + 1] ?? '') : 'production';
if (mode !== 'production' && mode !== 'development') {
  console.error(`Modo inválido "${mode}" (usa production o development).`);
  process.exit(1);
}
const watch = args.includes('--watch');
const outDir = join(ROOT, outDirOf(mode));

rmSync(outDir, { recursive: true, force: true });

for (const part of PARTS) {
  const config = partConfig(part, mode);
  if (watch) config.build = { ...config.build, watch: {} };
  await build(config);
}

if (watch) {
  console.log(`Vigilando cambios → ${outDir}`);
} else {
  checkBundle();
  console.log(`Extensión (${mode}) generada en ${outDir}`);
}

/** Guards against output that Chrome would refuse to run. */
function checkBundle(): void {
  const problems: string[] = [];
  for (const f of [BACKGROUND_FILE, CONTENT_FILE, 'popup.html', 'manifest.json']) {
    if (!existsSync(join(outDir, f))) problems.push(`falta ${f}`);
  }
  const bg = readFileSync(join(outDir, BACKGROUND_FILE), 'utf8');
  // Service workers reject dynamic import() at runtime.
  if (/\bimport\s*\(/.test(bg)) problems.push(`${BACKGROUND_FILE} contiene import() dinámico`);
  const content = readFileSync(join(outDir, CONTENT_FILE), 'utf8');
  // Content scripts are classic scripts: no ESM syntax.
  if (/^\s*(import|export)\s/m.test(content)) problems.push(`${CONTENT_FILE} contiene sintaxis ESM`);
  if (problems.length > 0) {
    console.error(`Build inválido:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}
