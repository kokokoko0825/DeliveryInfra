import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trimEnd();
};

function gitRefExists(ref) {
  return (
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root })
      .status === 0
  );
}

const candidates = process.env.GITHUB_BASE_REF
  ? [`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF]
  : ['origin/main', 'main'];
const baseRef = candidates.find(gitRefExists);
const base = (baseRef ? git('merge-base', baseRef, 'HEAD') : '') || 'HEAD';
const tracked = git('diff', '--name-only', '--diff-filter=ACMRT', base, '--')
  .split('\n')
  .filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter(Boolean);
const changed = [...new Set([...tracked, ...untracked])];
const productionExtensions = /\.(?:[cm]?[jt]sx?)$/u;
const testFile = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/u;
const packages = new Map([
  ['infra', { cwd: 'infra', config: 'stryker.config.json' }],
  [
    'packages/shared',
    { cwd: 'packages/shared', config: 'stryker.config.json' },
  ],
  ['apps/api', { cwd: 'apps/api', config: 'stryker.config.json' }],
  ['apps/web', { cwd: 'apps/web', config: 'stryker.core.config.json' }],
]);

const diagnosticLine = /recordClientDiagnostic|console\.(?:error|warn|info)|safeErrorDetails|failureResponse|api_request_failed|CHAT_EVENT_FAILED|(?:COMPENSATION|CLEANUP|INVITE|LEASE|BROADCAST)_FAILED|x-request-id|installGlobalErrorHandlers|downloadClientDiagnostics|EXPECTED_AUTH_FAILURES/u;

function selectorsFor(file, isTracked, packagePrefix) {
  const selectors = [];
  const absolute = `${root}${file}`;
  const diffArgs = isTracked
    ? ['diff', '--unified=0', base, '--', file]
    : ['diff', '--no-index', '--unified=0', '/dev/null', absolute];
  const patch = git(...diffArgs);

  if (file.endsWith('/src/lib/diagnostics.ts')) {
    const lineCount = readFileSync(absolute, 'utf8').split('\n').length;
    return [`${file.slice(packagePrefix.length + 1)}:1-${lineCount}`];
  }

  const lines = patch.split('\n');
  let newLine = 0;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (diagnosticLine.test(line.slice(1))) {
        const localPath = file.slice(packagePrefix.length + 1);
        selectors.push(`${localPath}:${newLine}-${newLine}`);
      }
      newLine += 1;
    } else if (!line.startsWith('-') && newLine > 0) {
      newLine += 1;
    }
  }

  if (file === 'apps/api/src/auth.ts' || file === 'apps/web/src/lib/auth.ts') {
    for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
      const start = Number(match[1]);
      const count = Number(match[2] ?? 1);
      if (count > 0) selectors.push(`${file.slice(packagePrefix.length + 1)}:${start}-${start + count - 1}`);
    }
  }

  if (file === 'apps/api/src/router.ts') {
    const source = readFileSync(absolute, 'utf8').split('\n');
    for (const declaration of ['const safeErrorDetails =', 'const failureResponse =']) {
      const start = source.findIndex((line) => line.includes(declaration));
      if (start < 0) continue;
      let end = start;
      while (end < source.length && !source[end].trim().endsWith('};')) end += 1;
      selectors.push(`${file.slice(packagePrefix.length + 1)}:${start + 1}-${end + 1}`);
    }
  }

  return [...new Set(selectors)];
}

const work = new Map();
const planOnly = process.argv.includes('--plan');
for (const file of changed) {
  if (
    !productionExtensions.test(file) ||
    testFile.test(file) ||
    file.includes(',')
  )
    continue;
  const entry = [...packages.entries()].find(([prefix]) =>
    file.startsWith(`${prefix}/`),
  );
  if (!entry) continue;
  const [prefix, config] = entry;
  const localPath = file.slice(prefix.length + 1);
  if (!work.has(prefix)) work.set(prefix, { ...config, selectors: [] });
  work
    .get(prefix)
    .selectors.push(...selectorsFor(file, tracked.includes(file), prefix));
}

if (!work.size) {
  console.log(
    '変更された本番ソースがないため、ローカルのミューテーションテストをスキップします。',
  );
  process.exit(0);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
for (const [name, task] of work) {
  const selectors = [...new Set(task.selectors)].join(',');
  console.log(`\n[mutation] ${name}: ${selectors}`);
  if (planOnly) continue;
  const testArgs =
    name === 'apps/web'
      ? ['--testFiles', 'src/**/*.test.ts,src/**/*.test.tsx']
      : [];
  const result = spawnSync(
    pnpm,
    [
      'exec',
      'stryker',
      'run',
      task.config,
      '--mutate',
      selectors,
      '--incremental',
      ...testArgs,
    ],
    {
      cwd: `${root}${task.cwd}`,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
