/**
 * Vite configs of each part of the extension. Three separate builds because
 * each part has a different runtime:
 *
 * - background: MV3 service worker, ES module (`background.type: "module"`),
 *   one self-contained file. Service workers do not support dynamic
 *   `import()`, hence `inlineDynamicImports`.
 * - content: classic script (IIFE). Content scripts cannot be ES modules.
 * - popup: extension page (`popup.html` + module script).
 */
import type { InlineConfig, Plugin } from 'vite';
import { join } from 'node:path';
import { ROOT, baseConfig, missingFirebaseValues, packageVersion, resolveBuildConfig } from './common.ts';
import { BACKGROUND_FILE, CONTENT_FILE, buildManifest } from './manifest.ts';

export type Part = 'background' | 'content' | 'popup';
export const PARTS: readonly Part[] = ['background', 'content', 'popup'];

function manifestPlugin(mode: string): Plugin {
  return {
    name: 'timetracking-manifest',
    generateBundle() {
      const cfg = resolveBuildConfig(mode);
      const manifest = buildManifest({
        appEnv: cfg.appEnv,
        version: packageVersion(),
        oauthClientId: cfg.oauthClientId,
      });
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
      if (cfg.appEnv === 'prod') {
        const missing = missingFirebaseValues(cfg);
        if (missing.length > 0) {
          this.warn(
            `.env.production sin configurar (${missing.join(', ')}): el build prod no podrá conectarse a Firebase. ` +
              'Ver extension/README.md.',
          );
        }
      }
    },
  };
}

export function partConfig(part: Part, mode: string): InlineConfig {
  const base = baseConfig(mode);
  const build = base.build ?? {};
  switch (part) {
    case 'background':
      return {
        ...base,
        plugins: [manifestPlugin(mode)],
        build: {
          ...build,
          rollupOptions: {
            input: { background: join(ROOT, 'src/background/index.ts') },
            output: {
              format: 'es',
              entryFileNames: BACKGROUND_FILE,
              codeSplitting: false,
            },
          },
        },
      };
    case 'content':
      return {
        ...base,
        build: {
          ...build,
          rollupOptions: {
            input: { content: join(ROOT, 'src/content/activity.ts') },
            output: {
              format: 'iife',
              entryFileNames: CONTENT_FILE,
              codeSplitting: false,
            },
          },
        },
      };
    case 'popup':
      return {
        ...base,
        build: {
          ...build,
          rollupOptions: {
            input: { popup: join(ROOT, 'popup.html') },
            output: {
              format: 'es',
              entryFileNames: 'popup.js',
              chunkFileNames: 'popup-[name].js',
              assetFileNames: 'assets/[name][extname]',
            },
          },
        },
      };
  }
}
