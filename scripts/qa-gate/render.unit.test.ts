import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Metrics } from './collect';

const tempDirs: string[] = [];

const COVERAGE = {
  lines: { total: 100, covered: 80, pct: 80 },
  statements: { total: 100, covered: 80, pct: 80 },
  functions: { total: 10, covered: 8, pct: 80 },
  branches: { total: 20, covered: 16, pct: 80 },
} as const;

const makeMetrics = (sha: string, lineCoverage: number): Metrics => ({
  sha,
  generatedAt: '2026-05-16T00:00:00.000Z',
  loc: {
    frontend: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    api: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    shared: { files: 1, code: 100, comment: 0, blank: 0, total: 100 },
    total: { files: 3, code: 300, comment: 0, blank: 0, total: 300 },
  },
  coverage: {
    frontend: {
      ...COVERAGE,
      lines: { total: 100, covered: lineCoverage, pct: lineCoverage },
    },
    api: COVERAGE,
    shared: COVERAGE,
  },
  tsErrors: { frontend: 0, api: 0, shared: 0 },
  duplication: { clones: 0, duplicatedLines: 0, percentage: 0 },
  circularDeps: 0,
  frontendBundle: {
    files: 4,
    rawBytes: 400_000,
    gzipBytes: 100_000,
    jsGzipBytes: 80_000,
    cssGzipBytes: 18_000,
    htmlGzipBytes: 2_000,
  },
  dependencies: {
    workspaceManifests: 4,
    directDependencies: 42,
    directDevDependencies: 30,
    lockedPackages: 250,
  },
  tests: {
    unit: {
      exitCode: 0,
      passed: 1_000,
      root: 4,
      frontend: 200,
      api: 700,
      shared: 96,
    },
    integration: {
      exitCode: 0,
      passed: 100,
      root: 0,
      frontend: 30,
      api: 70,
      shared: 0,
    },
  },
  tooling: { checkExitCode: 0, failedTasks: [] },
});

const writeMetrics = async (metrics: Metrics): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-render-'));
  tempDirs.push(dir);
  const path = join(dir, `${metrics.sha}.json`);
  await writeFile(path, JSON.stringify(metrics), 'utf8');
  return path;
};

interface RenderOptions {
  readonly expectedStderr?: string;
}

const render = async (
  basePath: string,
  headPath: string,
  options: RenderOptions = {}
): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ['bun', './scripts/qa-gate/render.ts', basePath, headPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (options.expectedStderr) {
    expect(stderr).toContain(options.expectedStderr);
  } else {
    expect(stderr).toBe('');
  }
  expect(exitCode).toBe(0);
  return stdout;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('QA gate comment renderer', () => {
  it('renders a stable marker and coverage delta for sticky PR comments', async () => {
    const basePath = await writeMetrics(makeMetrics('0123456789', 80));
    const headPath = await writeMetrics(makeMetrics('abcdef1234', 82));

    const comment = await render(basePath, headPath);

    expect(comment).toContain('## QA Gate');
    expect(comment).toContain('<!-- qa-gate-comment -->');
    expect(comment).toContain('Frontend line coverage');
    expect(comment).toContain('Frontend Bundle');
    expect(comment).toContain('Dependencies');
    expect(comment).toContain('Tests by Lane');
    expect(comment).toContain('Repo Tooling');
    expect(comment).toContain('API/shared branches and statements are source-derived');
    expect(comment).toContain('Full repo check');
    expect(comment).not.toContain('ESLint');
    expect(comment).toContain('+2pp');
  });

  it('keeps rendering when one metrics file is unavailable', async () => {
    const basePath = await writeMetrics(makeMetrics('0123456789', 80));

    const comment = await render(basePath, '/missing/metrics.json', {
      expectedStderr: 'failed to load /missing/metrics.json',
    });

    expect(comment).toContain('Collector errors');
    expect(comment).toContain('metrics file was not loadable');
  });
});
