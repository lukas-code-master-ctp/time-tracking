/**
 * Vite configs of each part of the extension. Three separate builds because
 * each part has a different runtime:
 *
 * - background: MV3 service worker, ES module (`background.type: "module"`),
 *   one self-contained file. Service workers do not support dynamic
 *   `import()`, hence `inlineDynamicImports`.
 * - content: classic script (IIFE). Content scripts cannot be ES modules.
 * - popup: extension pages (`popup.html`, `consent.html`, module scripts + CSS).
 */
import type { InlineConfig, Plugin } from 'vite';
import { join } from 'node:path';
import { ROOT, baseConfig, missingFirebaseValues, packageVersion, resolveBuildConfig, type BuildTarget } from './common.ts';
import { BACKGROUND_FILE, CONTENT_FILE, buildManifest } from './manifest.ts';
import { STORE_PUBLIC_KEY } from './store-key.ts';

export type Part = 'background' | 'content' | 'popup';
export const PARTS: readonly Part[] = ['background', 'content', 'popup'];

function manifestPlugin(target: BuildTarget): Plugin {
  return {
    name: 'timetracking-manifest',
    generateBundle() {
      const cfg = resolveBuildConfig(target);
      const manifest = buildManifest({
        appEnv: cfg.appEnv,
        version: packageVersion(),
        oauthClientId: cfg.oauthClientId,
        // Only QA: same ID as the store item. The store build never has `key`.
        publicKey: target === 'qa' ? STORE_PUBLIC_KEY : undefined,
      });
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
      // QA fails earlier (scripts/build.ts) if these values are missing.
      if (target === 'prod') {
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

export function partConfig(part: Part, target: BuildTarget, outDir?: string): InlineConfig {
  const base = baseConfig(target, outDir);
  const build = base.build ?? {};
  switch (part) {
    case 'background':
      return {
        ...base,
        plugins: [manifestPlugin(target)],
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
            input: { popup: join(ROOT, 'popup.html'), consent: join(ROOT, 'consent.html') },
            output: {
              format: 'es',
              entryFileNames: '[name].js',
              chunkFileNames: 'chunk-[name].js',
              assetFileNames: 'assets/[name][extname]',
            },
          },
        },
      };
  }
}
