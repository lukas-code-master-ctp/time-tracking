import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Landing estática de www.mipegahr.cl → landing/dist (proyecto propio en Vercel,
// Root Directory "landing"; ver landing/vercel.json).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5180 },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
