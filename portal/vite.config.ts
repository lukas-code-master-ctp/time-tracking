import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite --mode development` → emulators + dev login; `vite build --mode production`
// → portal/dist (served by Firebase Hosting, see firebase.json).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@timetracking/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // firebase (Firestore + Auth + Storage + Functions) is ~560 kB minified on its own.
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      output: {
        // Vendor chunks: cached across deploys of the app code.
        codeSplitting: {
          groups: [
            { name: 'firebase', test: /node_modules[\\/]@?firebase[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
