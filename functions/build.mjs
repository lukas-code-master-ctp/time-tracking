// Bundles the functions into a single `lib/index.js` for deployment.
//
// Cloud Build installs only what `package.json` lists in `dependencies`, and
// the workspace package `@timetracking/shared` is not published anywhere, so it
// is bundled into the output. Runtime dependencies stay external and are
// installed by Cloud Build with the exact versions pinned in package.json.
// `@timetracking/shared` must NOT be listed in functions/package.json (not even
// as a devDependency): Cloud Build runs `npm install` in `functions/` alone and
// would try to fetch it from the public registry (404, or worse, a squatted
// package). Locally it resolves through the workspace symlink in the root
// node_modules.
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

const workspaceDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
  name.startsWith('@timetracking/'),
);
if (workspaceDeps.length > 0) {
  console.error(
    `functions/package.json must not list workspace packages (${workspaceDeps.join(', ')}): ` +
      'Cloud Build cannot install them. They are bundled instead.',
  );
  process.exit(1);
}

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
