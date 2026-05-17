import { execSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { ALL_WORKSPACE_NAMES, ROOT_DIR, type WorkspaceName } from '../lib/config';
import { readWorkspaceCoverageSummary } from './coverage-summary';
import type { CoverageSummary } from './parse-lcov';
import { parseTestLanePassCounts } from './test-lane-summary';

// ── Types ──

export interface LocBucket {
  readonly files: number;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
  readonly total: number;
}

export interface DuplicationStats {
  readonly clones: number;
  readonly duplicatedLines: number;
  readonly percentage: number;
}

export interface BundleStats {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly jsGzipBytes: number;
  readonly cssGzipBytes: number;
  readonly htmlGzipBytes: number;
}

export interface DependencyStats {
  readonly workspaceManifests: number;
  readonly directDependencies: number;
  readonly directDevDependencies: number;
  readonly lockedPackages: number;
}

export type TestLaneName = 'unit' | 'integration';

export interface TestLaneStats {
  readonly exitCode: number | null;
  readonly passed: number;
  readonly root: number;
  readonly frontend: number;
  readonly api: number;
  readonly shared: number;
}

export interface ToolingCheckStats {
  readonly checkExitCode: number;
  readonly failedTasks: readonly string[];
}

export type Failable<T> = T | { readonly error: string };

export interface Metrics {
  readonly sha: string;
  readonly generatedAt: string;
  readonly loc: Readonly<Record<WorkspaceName | 'total', Failable<LocBucket>>>;
  readonly coverage: Readonly<Record<WorkspaceName, Failable<CoverageSummary>>>;
  readonly tsErrors: Readonly<Record<WorkspaceName, Failable<number>>>;
  readonly duplication: Failable<DuplicationStats>;
  readonly circularDeps: Failable<number>;
  readonly frontendBundle: Failable<BundleStats>;
  readonly dependencies: Failable<DependencyStats>;
  readonly tests: Readonly<Record<TestLaneName, Failable<TestLaneStats>>>;
  readonly tooling: Failable<ToolingCheckStats>;
}

// ── Helpers ──

const stderrLog = (message: string): void => {
  process.stderr.write(`[qa-gate] ${message}\n`);
};

const safe = async <T>(label: string, fn: () => Promise<T>): Promise<Failable<T>> => {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrLog(`${label} failed: ${message}`);
    return { error: message };
  }
};

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const runCapture = async (cmd: readonly string[], opts?: { cwd?: string }): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: opts?.cwd ?? ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

// ── LoC ──

const SOURCE_EXT_RE = /\.(ts|tsx)$/;
const EXCLUDED_PATH_FRAGMENTS = ['/dist/', '/coverage/', '/.tanstack/', '/node_modules/'];
const EXCLUDED_FILENAMES = new Set(['routeTree.gen.ts']);

const isSourceFile = (relPath: string): boolean => {
  if (!SOURCE_EXT_RE.test(relPath)) return false;
  if (EXCLUDED_PATH_FRAGMENTS.some((fragment) => relPath.includes(fragment))) return false;
  const fileName = relPath.split('/').pop() ?? '';
  if (EXCLUDED_FILENAMES.has(fileName)) return false;
  return true;
};

interface LineCounts {
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
}

const countLines = async (relPath: string): Promise<LineCounts> => {
  const text = await Bun.file(join(ROOT_DIR, relPath)).text();
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlockComment = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      blank++;
      continue;
    }
    if (inBlockComment) {
      comment++;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) {
      comment++;
      continue;
    }
    code++;
  }
  return { code, comment, blank };
};

const measureLoc = async (workspaceDir: string): Promise<LocBucket> => {
  const { stdout, exitCode, stderr } = await runCapture(['git', 'ls-files', workspaceDir]);
  if (exitCode !== 0) throw new Error(`git ls-files ${workspaceDir} failed: ${stderr.trim()}`);
  const sources = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(isSourceFile);

  let totalCode = 0;
  let totalComment = 0;
  let totalBlank = 0;
  for (const file of sources) {
    try {
      const counts = await countLines(file);
      totalCode += counts.code;
      totalComment += counts.comment;
      totalBlank += counts.blank;
    } catch (err) {
      stderrLog(`Skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    files: sources.length,
    code: totalCode,
    comment: totalComment,
    blank: totalBlank,
    total: totalCode + totalComment + totalBlank,
  };
};

// ── Coverage ──

const collectCoverage = (workspace: WorkspaceName): Promise<CoverageSummary> => {
  return readWorkspaceCoverageSummary(workspace);
};

// ── Repository tooling ──

// biome-ignore lint/complexity/useRegexLiterals: Keep the escape code out of a regex literal.
const ANSI_RE = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, 'g');

const collectFailedTasks = (text: string): readonly string[] => {
  const failedTasks: string[] = [];

  for (const line of text.replaceAll(ANSI_RE, '').split('\n')) {
    const match = line.match(/^\s+FAIL\s+(\S+)\s+/);
    if (match) failedTasks.push(match[1]);
  }

  return failedTasks;
};

const collectToolingStats = async (): Promise<ToolingCheckStats> => {
  const result = await runCapture(['bun', 'run', 'check']);
  const combined = `${result.stdout}\n${result.stderr}`;

  return {
    checkExitCode: result.exitCode,
    failedTasks: collectFailedTasks(combined),
  };
};

// ── TypeScript errors ──

const TS_ERROR_RE = /error TS\d+:/g;

const countTsErrors = async (workspace: WorkspaceName): Promise<number> => {
  const cfg = `apps/${workspace}/tsconfig.json`;
  const { stdout, stderr } = await runCapture([
    'bunx',
    'tsgo',
    '-p',
    cfg,
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const combined = `${stdout}\n${stderr}`;
  return (combined.match(TS_ERROR_RE) ?? []).length;
};

// ── Code duplication (jscpd) ──

const JSCPD_OUTPUT_DIR = '.jscpd-out';

const collectDuplication = async (): Promise<DuplicationStats> => {
  await runCapture([
    'bunx',
    'jscpd',
    'apps',
    '--silent',
    '--reporters',
    'json',
    '--output',
    JSCPD_OUTPUT_DIR,
    '--ignore',
    '**/dist/**,**/coverage/**,**/.tanstack/**,**/node_modules/**,**/routeTree.gen.ts',
  ]);
  const reportPath = join(ROOT_DIR, JSCPD_OUTPUT_DIR, 'jscpd-report.json');
  const text = await Bun.file(reportPath).text();
  const report = JSON.parse(text) as {
    statistics?: { total?: { clones?: number; duplicatedLines?: number; percentage?: number } };
  };
  const total = report.statistics?.total ?? {};
  return {
    clones: Number(total.clones ?? 0),
    duplicatedLines: Number(total.duplicatedLines ?? 0),
    percentage: Number(total.percentage ?? 0),
  };
};

// ── Circular deps (madge) ──

const countCircularDeps = async (): Promise<number> => {
  const counts = await Promise.all(
    ALL_WORKSPACE_NAMES.map(async (workspace) => {
      const { stdout } = await runCapture([
        'bunx',
        'madge',
        '--circular',
        '--extensions',
        'ts,tsx',
        '--json',
        `apps/${workspace}`,
      ]);
      const trimmed = stdout.trim() || '[]';
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    })
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

// ── Frontend bundle ──

const FRONTEND_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');
const BUNDLE_EXTENSIONS = new Set(['.css', '.html', '.js']);

const walkFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(path) : Promise.resolve([path]);
    })
  );
  return nested.flat();
};

const collectFrontendBundle = async (): Promise<BundleStats> => {
  const build = await runCapture(['bun', 'run', '--filter', '@mangostudio/frontend', 'build']);
  if (build.exitCode !== 0) {
    throw new Error(`frontend build failed: ${build.stderr || build.stdout}`.slice(0, 1_000));
  }

  const files = (await walkFiles(FRONTEND_DIST_DIR)).filter((path) =>
    BUNDLE_EXTENSIONS.has(extname(path))
  );
  let rawBytes = 0;
  let gzipBytes = 0;
  let jsGzipBytes = 0;
  let cssGzipBytes = 0;
  let htmlGzipBytes = 0;

  for (const path of files) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const compressedBytes = Bun.gzipSync(bytes).byteLength;
    rawBytes += bytes.byteLength;
    gzipBytes += compressedBytes;
    if (path.endsWith('.js')) jsGzipBytes += compressedBytes;
    else if (path.endsWith('.css')) cssGzipBytes += compressedBytes;
    else if (path.endsWith('.html')) htmlGzipBytes += compressedBytes;
  }

  return {
    files: files.length,
    rawBytes,
    gzipBytes,
    jsGzipBytes,
    cssGzipBytes,
    htmlGzipBytes,
  };
};

// ── Dependencies ──

const DEPENDENCY_LOCK_SNAPSHOT = join(ROOT_DIR, '.qa-gate/base-bun.lock');

const countWorkspaceDependencyEntries = (
  lockText: string,
  sectionName: 'dependencies' | 'devDependencies'
): number => {
  const workspacesText = lockText.split('\n  "packages": {')[0] ?? lockText;
  const sectionStart = new RegExp(`^\\s{6}"${sectionName}": \\{$`);
  let count = 0;
  let inSection = false;

  for (const line of workspacesText.split('\n')) {
    if (sectionStart.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s{6}},?$/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection && /^\s{8}"[^"]+":/.test(line)) count++;
  }

  return count;
};

const collectDependencyStats = async (): Promise<DependencyStats> => {
  const lockPath = (await Bun.file(DEPENDENCY_LOCK_SNAPSHOT).exists())
    ? DEPENDENCY_LOCK_SNAPSHOT
    : join(ROOT_DIR, 'bun.lock');
  const lockText = await Bun.file(lockPath).text();
  const workspacesText = lockText.split('\n  "packages": {')[0] ?? lockText;
  const packagesText = lockText.split('\n  "packages": {')[1] ?? '';

  return {
    workspaceManifests: (workspacesText.match(/^\s{4}"[^"]+": \{$/gm) ?? []).length,
    directDependencies: countWorkspaceDependencyEntries(lockText, 'dependencies'),
    directDevDependencies: countWorkspaceDependencyEntries(lockText, 'devDependencies'),
    lockedPackages: (packagesText.match(/^\s{4}"[^"]+": \[/gm) ?? []).length,
  };
};

// ── Test counts ──

const TEST_LANE_LOGS: Readonly<Record<TestLaneName, string>> = {
  unit: '.qa-gate/test-unit.log',
  integration: '.qa-gate/test-integration.log',
};

const TEST_LANE_EXIT_CODES: Readonly<Record<TestLaneName, string>> = {
  unit: '.qa-gate/test-unit.exit-code',
  integration: '.qa-gate/test-integration.exit-code',
};

const parseExitCode = async (relPath: string): Promise<number | null> => {
  const file = Bun.file(join(ROOT_DIR, relPath));
  if (!(await file.exists())) return null;
  const parsed = Number((await file.text()).trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const collectTestLaneStats = async (lane: TestLaneName): Promise<TestLaneStats> => {
  const text = await Bun.file(join(ROOT_DIR, TEST_LANE_LOGS[lane])).text();
  const stats = parseTestLanePassCounts(text);

  return {
    exitCode: await parseExitCode(TEST_LANE_EXIT_CODES[lane]),
    passed: stats.root + stats.frontend + stats.api + stats.shared,
    root: stats.root,
    frontend: stats.frontend,
    api: stats.api,
    shared: stats.shared,
  };
};

// ── Main ──

const getCommitSha = (): string => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: ROOT_DIR }).trim();
  } catch {
    return 'unknown';
  }
};

const buildMetrics = async (): Promise<Metrics> => {
  const loc: Record<string, Failable<LocBucket>> = {};
  const coverage: Record<string, Failable<CoverageSummary>> = {};
  const tsErrors: Record<string, Failable<number>> = {};

  for (const workspace of ALL_WORKSPACE_NAMES) {
    loc[workspace] = await safe(`loc:${workspace}`, () => measureLoc(`apps/${workspace}`));
    coverage[workspace] = await safe(`coverage:${workspace}`, () => collectCoverage(workspace));
    tsErrors[workspace] = await safe(`ts:${workspace}`, () => countTsErrors(workspace));
  }

  const validLoc = ALL_WORKSPACE_NAMES.map((workspace) => loc[workspace]).filter(
    (value): value is LocBucket => !('error' in value)
  );
  loc.total =
    validLoc.length === 0
      ? { error: 'no workspace LoC available' }
      : validLoc.reduce<LocBucket>(
          (acc, entry) => ({
            files: acc.files + entry.files,
            code: acc.code + entry.code,
            comment: acc.comment + entry.comment,
            blank: acc.blank + entry.blank,
            total: acc.total + entry.total,
          }),
          { files: 0, code: 0, comment: 0, blank: 0, total: 0 }
        );

  const duplication = await safe('duplication', collectDuplication);
  const circularDeps = await safe('circularDeps', countCircularDeps);
  const frontendBundle = await safe('frontendBundle', collectFrontendBundle);
  const dependencies = await safe('dependencies', collectDependencyStats);
  const tests = {
    unit: await safe('tests:unit', () => collectTestLaneStats('unit')),
    integration: await safe('tests:integration', () => collectTestLaneStats('integration')),
  } satisfies Metrics['tests'];
  const tooling = await safe('tooling', collectToolingStats);

  return {
    sha: getCommitSha(),
    generatedAt: new Date().toISOString(),
    loc: loc as Metrics['loc'],
    coverage: coverage as Metrics['coverage'],
    tsErrors: tsErrors as Metrics['tsErrors'],
    duplication,
    circularDeps,
    frontendBundle,
    dependencies,
    tests,
    tooling,
  };
};

const metrics = await buildMetrics();
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
