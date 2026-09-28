import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QA_METRICS_SCHEMA_VERSION, type QaMetricsEnvelope } from './metrics-envelope';
import { makeMetrics } from './testing/metrics-fixture';

const HEAD_SHA = `${'a'.repeat(39)}1`;
const BASE_SHA = `${'b'.repeat(39)}2`;
const OTHER_SHA = `${'c'.repeat(39)}3`;
const RENDER_REPORT = join(import.meta.dir, 'render-report.ts');

const headEnvelope = (): QaMetricsEnvelope => ({
  schemaVersion: QA_METRICS_SCHEMA_VERSION,
  repository: 'mango/studio',
  prNumber: 7,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  metrics: makeMetrics(HEAD_SHA),
});

/** Envelope a main-push run uploads for `sha` (null PR number and base). */
const baselineEnvelope = (sha: string, overrides: Partial<QaMetricsEnvelope> = {}) => ({
  schemaVersion: QA_METRICS_SCHEMA_VERSION,
  repository: 'mango/studio',
  prNumber: null,
  baseSha: null,
  headSha: sha,
  metrics: makeMetrics(sha),
  ...overrides,
});

interface ArtifactStatus {
  readonly found: boolean;
  readonly reason: string | null;
}

const FOUND: ArtifactStatus = { found: true, reason: null };

describe('render-report baseline handling', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'render-report-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the real script the publisher workflow runs, against files on disk. */
  const render = async (base: {
    text: string | null;
    artifact: ArtifactStatus;
  }): Promise<string> => {
    const context = {
      repository: 'mango/studio',
      prNumber: 7,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      runUrl: 'https://example.test/runs/42',
      headArtifact: FOUND,
      baseArtifact: base.artifact,
    };
    await writeFile(join(dir, 'context.json'), JSON.stringify(context));
    await writeFile(join(dir, 'head.json'), JSON.stringify(headEnvelope()));
    const args = ['context.json', '--head', 'head.json'];
    if (base.text !== null) {
      await writeFile(join(dir, 'base.json'), base.text);
      args.push('--base', 'base.json');
    }
    const proc = Bun.spawn(['bun', RENDER_REPORT, ...args], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`render-report exited ${exitCode} for ${base.text}`);
    return stdout;
  };

  const expectUnavailable = (report: string, reasonPart: string) => {
    expect(report).toContain('Baseline unavailable');
    expect(report).toContain(reasonPart);
    expect(report).toContain('**LoC (code):** n/a');
    // A missing baseline must never render as a zero delta.
    expect(report).not.toContain('= 0');
  };

  it('renders a valid complete failed-run baseline as a real comparison', async () => {
    const failing = makeMetrics(BASE_SHA, {
      tests: { ...makeMetrics(BASE_SHA).tests, exitCode: 1, passed: 1_000 } as never,
    });
    const report = await render({
      text: JSON.stringify(baselineEnvelope(BASE_SHA, { metrics: failing })),
      artifact: FOUND,
    });

    expect(report).not.toContain('Baseline unavailable');
    expect(report).toContain('**LoC (code):** ⚪ ▲ = 0');
  });

  it('is unavailable when the run had no artifact', async () => {
    const report = await render({
      text: null,
      artifact: { found: false, reason: 'run has no qa-metrics artifact' },
    });

    expectUnavailable(report, 'run has no qa-metrics artifact');
  });

  it('is unavailable for a schema-invalid artifact', async () => {
    const invalid = { ...baselineEnvelope(BASE_SHA), extra: 'field' };
    const report = await render({ text: JSON.stringify(invalid), artifact: FOUND });

    expectUnavailable(report, 'schema validation');
  });

  it('is unavailable for a partial (truncated) artifact', async () => {
    const truncated = JSON.stringify(baselineEnvelope(BASE_SHA)).slice(0, 200);
    const report = await render({ text: truncated, artifact: FOUND });

    expectUnavailable(report, 'not valid JSON');
  });

  it('is unavailable for an artifact recorded against a different sha', async () => {
    const report = await render({
      text: JSON.stringify(baselineEnvelope(OTHER_SHA)),
      artifact: FOUND,
    });

    expectUnavailable(report, `metrics headSha ${OTHER_SHA} does not match ${BASE_SHA}`);
  });
});
