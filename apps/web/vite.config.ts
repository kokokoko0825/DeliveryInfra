import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(fileURLToPath(new URL('.', import.meta.url)), 'src') } },
  test: { environment: 'jsdom', setupFiles: './src/test-setup.ts', exclude: [...configDefaults.exclude, '**/.stryker-tmp*/**'] },
});
