import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineCommit, rulesHash } from './engineVersion.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Engine version stamps (Nov 2026): every shadow verdict and logged trade records
  // the build and the engine rules that produced it. See engineVersion.mjs.
  define: {
    __ENGINE_COMMIT__: JSON.stringify(engineCommit(process.env, here)),
    __RULES_HASH__: JSON.stringify(rulesHash(path.join(here, 'src', 'engine'))),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001'
    }
  }
});
