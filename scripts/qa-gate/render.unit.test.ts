import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Metrics } from './collect/types';
import { makeCoverageSummary, makeMetrics } from './testing/metrics-fixture';

const tempDirs: string[] = [];

const makeMetricsWithFrontendLines = (sha: string, lineCoverage: number): Metrics =>
  makeMetrics(sha, {
    coverage: {
      frontend: makeCoverageSummary(lineCoverage),
      api: makeCoverageSummary(),
      shared: makeCoverageSummary(),
    },
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
    const basePath = await writeMetrics(makeMetricsWithFrontendLines('0123456789', 80));
    const headPath = await writeMetrics(makeMetricsWithFrontendLines('abcdef1234', 82));

    const comment = await render(basePath, headPath);

    expect(comment).toContain('## QA Gate');
    expect(comment).toContain('<!-- qa-gate-comment -->');
    expect(comment).toContain('✅ **No attention signals**');
    expect(comment).toContain('Line coverage (all workspaces)');
    expect(comment).toContain('<summary>Metric details');
    expect(comment).toContain('Frontend Bundle');
    expect(comment).toContain('Dependencies');
    expect(comment).toContain('Tests by Lane');
    expect(comment).toContain('Repo Tooling');
    expect(comment).toContain('API/shared branches and statements are source-derived');
    expect(comment).toContain('Full repo check');
    expect(comment).not.toContain('ESLint');
    expect(comment).toContain('+2pp');
  });

  it('surfaces head regressions in the verdict headline', async () => {
    const basePath = await writeMetrics(makeMetrics('0123456789'));
    const headPath = await writeMetrics(
      makeMetrics('abcdef1234', { tooling: { checkExitCode: 1, failedTasks: ['typecheck'] } })
    );

    const comment = await render(basePath, headPath);

    expect(comment).toContain('⚠️ **Needs attention:** repo check failing: typecheck');
  });

  it('keeps rendering when one metrics file is unavailable', async () => {
    const basePath = await writeMetrics(makeMetricsWithFrontendLines('0123456789', 80));

    const comment = await render(basePath, '/missing/metrics.json', {
      expectedStderr: 'failed to load /missing/metrics.json',
    });

    expect(comment).toContain('Collector errors');
    expect(comment).toContain('metrics file was not loadable');
  });

  // Regression: when a collector job fails, the workflow writes `{}` as the
  // placeholder artifact. That parses to a valid object but has no metric
  // records, which used to crash collectErrorNotes on metrics.coverage[ws].
  it('keeps rendering when one metrics file is an empty placeholder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-render-'));
    tempDirs.push(dir);
    const emptyBasePath = join(dir, 'empty.json');
    await writeFile(emptyBasePath, '{}', 'utf8');
    const headPath = await writeMetrics(makeMetricsWithFrontendLines('abcdef1234', 82));

    const comment = await render(emptyBasePath, headPath, {
      expectedStderr: 'lacks metric fields; treating side as absent',
    });

    expect(comment).toContain('## QA Gate');
    expect(comment).toContain('<!-- qa-gate-comment -->');
    expect(comment).toContain('metrics file was not loadable');
  });
});
