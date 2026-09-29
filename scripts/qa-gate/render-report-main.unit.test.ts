import { describe, expect, it } from 'bun:test';

import { main, type RenderReportDeps, type ReportContext } from './render-report';

const CONTEXT: ReportContext = {
  repository: 'mango/studio',
  prNumber: 7,
  headSha: `${'a'.repeat(39)}1`,
  baseSha: `${'b'.repeat(39)}2`,
  runUrl: 'https://example.test/runs/42',
  headArtifact: { found: true, reason: null },
  baseArtifact: { found: true, reason: null },
};

type MetricsPaths = { headPath: string | null; basePath: string | null; ciPath: string | null };

/** Named fake of everything `main` touches: the context file, both renderers and both streams. */
const makeFakeReport = () => {
  const calls = {
    read: [] as string[],
    metrics: [] as Array<{ context: ReportContext; paths: MetricsPaths }>,
    commits: [] as ReportContext[],
    stdout: [] as string[],
    stderr: [] as string[],
  };
  const deps: RenderReportDeps = {
    readText: (path) => {
      calls.read.push(path);
      return Promise.resolve(JSON.stringify(CONTEXT));
    },
    renderMetrics: (context, paths) => {
      calls.metrics.push({ context, paths });
      return Promise.resolve('## QA metrics body');
    },
    renderCommits: (context) => {
      calls.commits.push(context);
      return '## Commits body';
    },
    write: (text) => {
      calls.stdout.push(text);
    },
    writeError: (text) => {
      calls.stderr.push(text);
    },
  };
  return { deps, calls };
};

describe('render-report main', () => {
  it('renders the metrics part with every path flag and writes it with a trailing newline', async () => {
    const { deps, calls } = makeFakeReport();

    const exitCode = await main(
      ['ctx.json', '--part', 'metrics', '--head', 'h.json', '--base', 'b.json', '--ci', 'c.json'],
      deps
    );

    expect(exitCode).toBe(0);
    expect(calls.read).toEqual(['ctx.json']);
    expect(calls.metrics).toHaveLength(1);
    expect(calls.metrics[0]?.context).toEqual(CONTEXT);
    expect(calls.metrics[0]?.paths).toMatchObject({
      headPath: 'h.json',
      basePath: 'b.json',
      ciPath: 'c.json',
    });
    expect(calls.commits).toEqual([]);
    expect(calls.stdout).toEqual(['## QA metrics body\n']);
    expect(calls.stderr).toEqual([]);
  });

  it('passes null for an absent path flag and for a flag whose value is another flag', async () => {
    const { deps, calls } = makeFakeReport();

    await main(['ctx.json', '--part', 'metrics', '--head', '--base'], deps);

    expect(calls.metrics[0]?.paths).toMatchObject({
      headPath: null,
      basePath: null,
      ciPath: null,
    });
  });

  it('renders the commits part from the context and never the metrics renderer', async () => {
    const { deps, calls } = makeFakeReport();

    const exitCode = await main(['ctx.json', '--part', 'commits'], deps);

    expect(exitCode).toBe(0);
    expect(calls.commits).toEqual([CONTEXT]);
    expect(calls.metrics).toEqual([]);
    expect(calls.stdout).toEqual(['## Commits body\n']);
  });

  it.each([
    {
      argv: ['ctx.json', '--part', 'invalid'],
      received: 'context "ctx.json" and --part "invalid"',
    },
    { argv: ['ctx.json'], received: 'context "ctx.json" and --part null' },
    { argv: ['ctx.json', '--part', '--head'], received: 'context "ctx.json" and --part null' },
    { argv: ['--part', 'metrics'], received: 'context "--part" and --part null' },
    { argv: [], received: 'context null and --part null' },
  ])('exits 1 naming what it received for $argv', async ({ argv, received }) => {
    const { deps, calls } = makeFakeReport();

    const exitCode = await main(argv, deps);

    expect(exitCode).toBe(1);
    expect(calls.stderr.join('')).toContain(`Received ${received}`);
    expect(calls.stderr.join('')).toContain(
      'expected a context path and --part one of metrics, commits'
    );
    expect(calls.stderr.join('')).toContain('Usage: bun ./scripts/qa-gate/render-report.ts');
    // A refused invocation reads nothing and writes no report.
    expect(calls.read).toEqual([]);
    expect(calls.metrics).toEqual([]);
    expect(calls.commits).toEqual([]);
    expect(calls.stdout).toEqual([]);
  });
});
