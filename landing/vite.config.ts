import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Landing estática de www.mipegahr.cl → landing/dist. Se publica en el mismo
// proyecto de Vercel que el portal: el vercel.json de la raíz la copia a
// portal/dist/_landing y reescribe todo el host www.mipegahr.cl hacia ahí.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5180 },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
