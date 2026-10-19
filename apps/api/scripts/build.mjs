import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

const handlers = [['api', 'index'], ['chat-review', 'chat-review'], ['recording', 'recording'], ['cognito-trigger', 'cognito']];
await rm('dist', { recursive: true, force: true });
for (const [outputName, sourceName] of handlers) {
  const outfile = `dist/${outputName}/index.mjs`;
  await mkdir(`dist/${outputName}`, { recursive: true });
  await build({
    entryPoints: [`src/${sourceName}.ts`], outfile, bundle: true,
    platform: 'node', target: 'node22', format: 'esm', sourcemap: true,
  });
}
