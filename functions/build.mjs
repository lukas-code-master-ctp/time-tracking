// Bundles the functions into a single `lib/index.js` for deployment.
//
// Cloud Build installs only what `package.json` lists in `dependencies`, and
// the workspace package `@timetracking/shared` is not published anywhere, so it
// is bundled into the output. Runtime dependencies stay external and are
// installed by Cloud Build with the exact versions pinned in package.json.
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

rmSync(new URL('./lib', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // esbuild also treats subpaths (`firebase-functions/v2/https`) as external.
  external,
  logLevel: 'info',
});

const out = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
if (out.includes('@timetracking/shared')) {
  console.error('lib/index.js still imports @timetracking/shared; it must be bundled.');
  process.exit(1);
}
