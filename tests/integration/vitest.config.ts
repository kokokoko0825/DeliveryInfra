import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web のソースを直接 import するため、web と同じ '@' エイリアスを使う。
      '@': fileURLToPath(new URL('../../apps/web/src', import.meta.url)),
      // ブラウザ専用の WebRTC SDK は HTTP 契約の対象外なのでスタブにする。
      'amazon-ivs-web-broadcast': fileURLToPath(new URL('./test/stubs/amazon-ivs-web-broadcast.ts', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 },
});
