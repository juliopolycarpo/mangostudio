import { describe, expect, it } from 'bun:test';

import { CI_JOBS_MAX_ITEMS } from '../ci-durations';
import {
  QA_METRICS_SCHEMA_VERSION,
  QA_METRICS_ARTIFACT_NAME as TS_ARTIFACT_NAME,
} from '../metrics-envelope';
import { unavailable } from '../model/states';
import { makeMetrics } from '../testing/metrics-fixture';
import { buildZip } from '../testing/zip-fixture';
import {
  CI_WORKFLOW_FILE,
  collectCiDurations,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_CI_JOBS,
  QA_METRICS_ARTIFACT_NAME,
  resolveReportInputs,
} from './report-pipeline.mjs';

const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const ADVANCED_BASE_SHA = '89abcdef0123456789abcdef0123456789abcdef';

type ReportInputs = Awaited<ReturnType<typeof resolveReportInputs>>;

/**
 * `resolveReportInputs` returns a bare `{ skip }` when there is nothing to
 * publish, so its publishing fields are absent on that branch. Assert the
 * publishing shape once instead of re-checking every field at every assertion,
 * and fail with the skip reason rather than a bare property read.
 */
const publishable = (result: ReportInputs) => {
  const { reportContext, ciDurations } = result;
  if (!reportContext || !ciDurations) {
    throw new Error(`expected publishable inputs, got skip: ${String(result.skip)}`);
  }
  return { ...result, reportContext, ciDurations };
};

interface FakeArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly size_in_bytes: number;
}

interface FakeJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface FakeRun {
  readonly id: number;
  readonly head_sha: string;
  readonly head_branch: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
}

interface FakeOptions {
  readonly pullRequests?: unknown[];
  readonly artifactsByRun?: Record<number, FakeArtifact[]>;
  readonly baselineRuns?: FakeRun[];
  /** A misbehaving API that ignores the `head_sha` filter. */
  readonly ignoreHeadShaFilter?: boolean;
  readonly previousRuns?: unknown[];
  readonly archives?: Record<number, Uint8Array>;
  readonly jobsByRun?: Record<number, FakeJob[]>;
  readonly jobErrorsByRun?: Record<number, string>;
}

class FakeGithub {
  readonly downloadedArtifactIds: number[] = [];
  readonly workflowRunQueries: Array<Record<string, unknown>> = [];

  constructor(private readonly options: FakeOptions) {}

  readonly rest = {
    pulls: { list: 'pulls-list-route' },
    actions: {
      listWorkflowRunArtifacts: 'list-artifacts-route',
      listJobsForWorkflowRun: 'list-jobs-route',
      downloadArtifact: ({ artifact_id }: { artifact_id: number }) => {
        this.downloadedArtifactIds.push(artifact_id);
        const archive = this.options.archives?.[artifact_id] ?? new Uint8Array([123]);
        return Promise.resolve({ data: archive.buffer });
      },
      listWorkflowRuns: (params: Record<string, unknown>) => {
        this.workflowRunQueries.push(params);
        const runs = params.head_sha
          ? this.matchingBaselineRuns(params)
          : this.options.previousRuns;
        return Promise.resolve({ data: { workflow_runs: runs ?? [] } });
      },
    },
  };

  /** Mirrors GitHub: `status` matches either the run status or its conclusion. */
  private matchingBaselineRuns(params: Record<string, unknown>): FakeRun[] {
    return (this.options.baselineRuns ?? []).filter(
      (run) =>
        (this.options.ignoreHeadShaFilter || run.head_sha === params.head_sha) &&
        run.event === params.event &&
        (run.status === params.status || run.conclusion === params.status)
    );
  }

  paginate = (route: unknown, params: Record<string, unknown>) => {
    if (route === this.rest.pulls.list) {
      return Promise.resolve(this.options.pullRequests ?? []);
    }
    if (route === this.rest.actions.listWorkflowRunArtifacts) {
      return Promise.resolve(this.options.artifactsByRun?.[params.run_id as number] ?? []);
    }
    if (route === this.rest.actions.listJobsForWorkflowRun) {
      const runId = params.run_id as number;
      const error = this.options.jobErrorsByRun?.[runId];
      if (error) throw new Error(error);
      return Promise.resolve(this.options.jobsByRun?.[runId] ?? []);
    }
    throw new Error('unexpected paginate route');
  };
}

const FORK_REPOSITORY = { owner: { login: 'forker' } };

const context = {
  repo: { owner: 'mango', repo: 'studio' },
  payload: {
    workflow_run: {
      id: 42,
      event: 'pull_request',
      head_sha: HEAD_SHA,
      head_branch: 'feat/thing',
      head_repository: FORK_REPOSITORY,
      html_url: 'https://example.test/runs/42',
    },
  },
};

const openPr = {
  number: 7,
  head: { sha: HEAD_SHA },
  base: { sha: BASE_SHA },
};

const artifact = (id: number, overrides: Partial<FakeArtifact> = {}): FakeArtifact => ({
  id,
  name: QA_METRICS_ARTIFACT_NAME,
  expired: false,
  size_in_bytes: 1024,
  ...overrides,
});

const mainRun = (id: number, overrides: Partial<FakeRun> = {}): FakeRun => ({
  id,
  head_sha: BASE_SHA,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

/** A qa-metrics artifact zip whose envelope records `baseSha`, as the collector writes it. */
const metricsArchive = (baseSha: string | null = BASE_SHA): Uint8Array =>
  buildZip([
    {
      name: 'metrics.json',
      content: JSON.stringify({ schemaVersion: QA_METRICS_SCHEMA_VERSION, baseSha }),
    },
  ]);

/** The qa-metrics archive a main-push run uploads for `sha`. */
const baselineArchive = (
  sha: string,
  metrics: object = makeMetrics(sha),
  schemaVersion: number = QA_METRICS_SCHEMA_VERSION
): Uint8Array =>
  buildZip([
    {
      name: 'metrics.json',
      content: JSON.stringify({ schemaVersion, headSha: sha, baseSha: null, metrics }),
    },
  ]);

const job = (name: string, overrides: Partial<FakeJob> = {}): FakeJob => ({
  name,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-07-25T00:00:00Z',
  completed_at: '2026-07-25T00:01:00Z',
  ...overrides,
});

describe('artifact name pinning', () => {
  it('matches the TypeScript collector constant', () => {
    expect(QA_METRICS_ARTIFACT_NAME).toBe(TS_ARTIFACT_NAME);
  });

  it('caps collected jobs at the schema bound so oversized runs still render', () => {
    expect(MAX_CI_JOBS).toBe(CI_JOBS_MAX_ITEMS);
  });
});

describe('resolveReportInputs', () => {
  it('skips non-pull_request runs', async () => {
    const github = new FakeGithub({});
    const pushContext = {
      ...context,
      payload: { workflow_run: { ...context.payload.workflow_run, event: 'push' } },
    };

    const result = await resolveReportInputs({ github, context: pushContext });

    expect(result.skip).toContain('not a pull_request run');
  });

  it('skips when no open PR matches the exact triggering head sha', async () => {
    const github = new FakeGithub({
      pullRequests: [{ ...openPr, head: { sha: 'different-sha' } }],
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.skip).toContain('no open pull request');
  });

  it('resolves head and baseline archives with trusted provenance', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      baselineRuns: [mainRun(90)],
      previousRuns: [{ id: 41, pull_requests: [{ number: 7 }] }],
      artifactsByRun: { 42: [artifact(1)], 90: [artifact(2)] },
      archives: { 1: metricsArchive(), 2: baselineArchive(BASE_SHA) },
      jobsByRun: {
        42: [job('Test / Run tests')],
        90: [job('Test / Run tests')],
        41: [job('Test / Run tests')],
      },
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.skip).toBeNull();
    expect(result.headArchive).toEqual(metricsArchive());
    expect(result.baseArchive).toEqual(baselineArchive(BASE_SHA));
    expect(result.ciDurations).toEqual({
      base: {
        runId: 90,
        error: null,
        jobs: [
          {
            name: 'Test / Run tests',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2026-07-25T00:00:00Z',
            completedAt: '2026-07-25T00:01:00Z',
          },
        ],
      },
      head: {
        runId: 42,
        error: null,
        jobs: [
          {
            name: 'Test / Run tests',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2026-07-25T00:00:00Z',
            completedAt: '2026-07-25T00:01:00Z',
          },
        ],
      },
      previous: {
        runId: 41,
        error: null,
        jobs: [
          {
            name: 'Test / Run tests',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2026-07-25T00:00:00Z',
            completedAt: '2026-07-25T00:01:00Z',
          },
        ],
      },
    });
    expect(github.downloadedArtifactIds).toEqual([1, 2]);
    expect(github.workflowRunQueries).toEqual([
      {
        owner: 'mango',
        repo: 'studio',
        workflow_id: CI_WORKFLOW_FILE,
        head_sha: BASE_SHA,
        event: 'push',
        status: 'completed',
        per_page: 10,
      },
      {
        owner: 'mango',
        repo: 'studio',
        workflow_id: CI_WORKFLOW_FILE,
        branch: 'feat/thing',
        event: 'pull_request',
        status: 'success',
        per_page: 100,
      },
    ]);
    expect(result.reportContext).toEqual({
      repository: 'mango/studio',
      prNumber: 7,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseShaRecorded: true,
      runUrl: 'https://example.test/runs/42',
      headArtifact: { found: true, reason: null },
      baseArtifact: { found: true, reason: null },
    });
  });

  it('reports a missing baseline run without approximating it', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1)] },
      archives: { 1: metricsArchive() },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact.found).toBe(false);
    expect(result.reportContext.baseArtifact.reason).toContain(
      `no completed, non-cancelled main CI run found for base ${BASE_SHA}`
    );
  });

  it('rejects oversized artifacts before downloading them', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: {
        42: [artifact(1, { size_in_bytes: MAX_ARTIFACT_ARCHIVE_BYTES + 1 })],
      },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.headArchive).toBeNull();
    expect(result.reportContext.headArtifact.reason).toContain('exceeds');
    expect(github.downloadedArtifactIds).toEqual([]);
  });

  it('ignores expired artifacts and reports them as missing', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1, { expired: true })] },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.headArchive).toBeNull();
    expect(result.reportContext.headArtifact.reason).toContain('no qa-metrics artifact');
  });

  it('keeps Actions jobs API failures report-only', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1)] },
      jobErrorsByRun: { 42: 'temporary jobs API outage' },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.skip).toBeNull();
    expect(result.ciDurations.head).toEqual({
      runId: 42,
      error: 'Actions jobs API failed: temporary jobs API outage',
      jobs: [],
    });
  });

  it('matches the previous fork run, whose pull_requests array is always empty', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      previousRuns: [
        { id: 41, pull_requests: [], head_branch: 'feat/thing', head_repository: FORK_REPOSITORY },
      ],
      artifactsByRun: { 42: [artifact(1)] },
      jobsByRun: { 41: [job('Test / Run tests')] },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.ciDurations.previous.runId).toBe(41);
    expect(result.ciDurations.previous.error).toBeNull();
  });

  it('ignores same-branch runs from a different fork', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      previousRuns: [
        {
          id: 41,
          pull_requests: [],
          head_branch: 'feat/thing',
          head_repository: { owner: { login: 'someone-else' } },
        },
      ],
      artifactsByRun: { 42: [artifact(1)] },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.ciDurations.previous.runId).toBeNull();
    expect(result.ciDurations.previous.error).toContain('no previous successful CI run');
  });
});

describe('baseline resolution', () => {
  const baselineFixture = (options: Partial<FakeOptions> = {}) =>
    new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1)], 90: [artifact(2)] },
      archives: { 1: metricsArchive(), 2: baselineArchive(BASE_SHA) },
      baselineRuns: [mainRun(90)],
      ...options,
    });

  it('selects a failed main run that still has a metrics artifact for the exact base', async () => {
    const github = baselineFixture({ baselineRuns: [mainRun(90, { conclusion: 'failure' })] });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseArtifact).toEqual({ found: true, reason: null });
    expect(result.baseArchive).toEqual(baselineArchive(BASE_SHA));
    expect(github.downloadedArtifactIds).toEqual([1, 2]);
    expect(result.ciDurations.base.runId).toBe(90);
  });

  it('never selects a canceled main run, even one that has an artifact', async () => {
    const github = baselineFixture({ baselineRuns: [mainRun(90, { conclusion: 'cancelled' })] });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact.found).toBe(false);
    expect(result.reportContext.baseArtifact.reason).toContain('non-cancelled');
    expect(github.downloadedArtifactIds).toEqual([1]);
  });

  it('skips a canceled run and falls through to an older run with an artifact', async () => {
    const github = baselineFixture({
      baselineRuns: [
        mainRun(91, { conclusion: 'cancelled' }),
        mainRun(90, { conclusion: 'failure' }),
      ],
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toEqual(baselineArchive(BASE_SHA));
    expect(result.ciDurations.base.runId).toBe(90);
  });

  it('ignores runs that are still in progress', async () => {
    const github = baselineFixture({
      baselineRuns: [mainRun(90, { status: 'in_progress', conclusion: null })],
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
  });

  it('is unavailable, never zero, when the baseline run has no artifact', async () => {
    const github = baselineFixture({ artifactsByRun: { 42: [artifact(1)] } });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact.found).toBe(false);
    expect(result.reportContext.baseArtifact.reason).toContain('run has no qa-metrics artifact');
  });

  it('is unavailable when the baseline artifact expired', async () => {
    const github = baselineFixture({
      artifactsByRun: { 42: [artifact(1)], 90: [artifact(2, { expired: true })] },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(github.downloadedArtifactIds).toEqual([1]);
  });

  it.each([
    [
      'schema-invalid (not JSON)',
      () => buildZip([{ name: 'metrics.json', content: '{bad' }]),
      'unreadable',
    ],
    ['truncated', () => baselineArchive(BASE_SHA).slice(0, 60), 'unreadable'],
    [
      'partial (an unavailable metric)',
      () =>
        baselineArchive(
          BASE_SHA,
          makeMetrics(BASE_SHA, { frontendBundle: unavailable('frontend dist missing') })
        ),
      'partial: 1 metric(s) not fully measured (metrics/frontendBundle=unavailable)',
    ],
    [
      'recorded for a different sha',
      () => baselineArchive(ADVANCED_BASE_SHA),
      `headSha "${ADVANCED_BASE_SHA}" does not match base ${BASE_SHA}`,
    ],
  ])('is unavailable, never zero, for a %s baseline artifact', async (_label, makeArchive, why) => {
    const github = baselineFixture({ archives: { 1: metricsArchive(), 2: makeArchive() } });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseArtifact).toEqual({
      found: false,
      reason: expect.stringContaining(why),
    });
    expect(result.baseArchive).toBeNull();
  });

  it('falls through a partial newest run to an older complete run', async () => {
    const partial = makeMetrics(BASE_SHA, { circularDeps: unavailable('madge crashed') });
    const github = baselineFixture({
      baselineRuns: [mainRun(91, { conclusion: 'failure' }), mainRun(90)],
      artifactsByRun: { 42: [artifact(1)], 91: [artifact(3)], 90: [artifact(2)] },
      archives: {
        1: metricsArchive(),
        3: baselineArchive(BASE_SHA, partial),
        2: baselineArchive(BASE_SHA),
      },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseArtifact).toEqual({ found: true, reason: null });
    expect(result.baseArchive).toEqual(baselineArchive(BASE_SHA));
    expect(result.ciDurations.base.runId).toBe(90);
  });

  // A v3 baseline exists but is historical. The report must say it is
  // incomparable, not that no baseline was found.
  it('reports a v3-only baseline as incomparable, never as a missing main CI run', async () => {
    const github = baselineFixture({
      archives: { 1: metricsArchive(), 2: baselineArchive(BASE_SHA, makeMetrics(BASE_SHA), 3) },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact).toEqual({
      found: false,
      reason: expect.stringContaining('is incomparable: recorded under schema version 3'),
      incomparable: true,
    });
    expect(result.reportContext.baseArtifact.reason).not.toContain('no completed');
    expect(result.ciDurations.base.runId).toBe(90);
  });

  it('prefers an older v4 run over a newer v3 run for the same base', async () => {
    const github = baselineFixture({
      baselineRuns: [mainRun(91), mainRun(90)],
      artifactsByRun: { 42: [artifact(1)], 91: [artifact(3)], 90: [artifact(2)] },
      archives: {
        1: metricsArchive(),
        3: baselineArchive(BASE_SHA, makeMetrics(BASE_SHA), 3),
        2: baselineArchive(BASE_SHA),
      },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseArtifact).toEqual({ found: true, reason: null });
    expect(result.ciDurations.base.runId).toBe(90);
  });

  it('keeps the partial reason, not incomparable, when a partial v4 run sits beside a v3 run', async () => {
    const partial = makeMetrics(BASE_SHA, { circularDeps: unavailable('madge crashed') });
    const github = baselineFixture({
      baselineRuns: [mainRun(91), mainRun(90)],
      artifactsByRun: { 42: [artifact(1)], 91: [artifact(3)], 90: [artifact(2)] },
      archives: {
        1: metricsArchive(),
        3: baselineArchive(BASE_SHA, partial),
        2: baselineArchive(BASE_SHA, makeMetrics(BASE_SHA), 3),
      },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseArtifact.incomparable).toBeUndefined();
  });

  it('never accepts a run whose head sha differs from the recorded base', async () => {
    const github = baselineFixture({
      baselineRuns: [mainRun(90, { head_sha: ADVANCED_BASE_SHA })],
      ignoreHeadShaFilter: true,
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
    expect(github.downloadedArtifactIds).toEqual([1]);
  });

  it('never accepts a push run from a branch other than main', async () => {
    const github = baselineFixture({ baselineRuns: [mainRun(90, { head_branch: 'feat/x' })] });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.baseArchive).toBeNull();
  });

  it('compares against the recorded base when the live PR base has advanced', async () => {
    const github = baselineFixture({
      pullRequests: [{ ...openPr, base: { sha: ADVANCED_BASE_SHA } }],
      // A run exists for the live tip too; it must never be consulted.
      baselineRuns: [mainRun(90), mainRun(95, { head_sha: ADVANCED_BASE_SHA })],
      artifactsByRun: { 42: [artifact(1)], 90: [artifact(2)], 95: [artifact(3)] },
      archives: {
        1: metricsArchive(BASE_SHA),
        2: baselineArchive(BASE_SHA),
        3: baselineArchive(ADVANCED_BASE_SHA),
      },
    });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.reportContext.baseSha).toBe(BASE_SHA);
    expect(result.baseArchive).toEqual(baselineArchive(BASE_SHA));
    const baselineQuery = github.workflowRunQueries.find((query) => query.head_sha);
    expect(baselineQuery?.head_sha).toBe(BASE_SHA);
    expect(github.downloadedArtifactIds).toEqual([1, 2]);
  });

  it.each([
    ['null recorded base', metricsArchive(null), 'is not a 40-character lowercase hex SHA'],
    ['unreadable head archive', new Uint8Array([123]), 'unreadable'],
  ])(
    'renders the baseline unavailable for a %s, without a lookup',
    async (_label, archive, why) => {
      const github = baselineFixture({
        pullRequests: [{ ...openPr, base: { sha: ADVANCED_BASE_SHA } }],
        archives: { 1: archive, 2: baselineArchive(BASE_SHA) },
      });

      const result = publishable(await resolveReportInputs({ github, context }));

      expect(result.baseArchive).toBeNull();
      expect(result.reportContext.baseArtifact.found).toBe(false);
      expect(result.reportContext.baseArtifact.reason).toContain(`baseline unavailable`);
      expect(result.reportContext.baseArtifact.reason).toContain(why);
      expect(github.workflowRunQueries.some((query) => query.head_sha)).toBe(false);
      expect(github.downloadedArtifactIds).toEqual([1]);
      // The live base only labels the commit range; it never selects a baseline.
      expect(result.reportContext.baseSha).toBe(ADVANCED_BASE_SHA);
    }
  );

  it('renders the baseline unavailable when the head has no artifact', async () => {
    const github = baselineFixture({ artifactsByRun: {} });

    const result = publishable(await resolveReportInputs({ github, context }));

    expect(result.headArchive).toBeNull();
    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact.reason).toContain(
      'head qa-metrics artifact is unavailable'
    );
  });
});

describe('collectCiDurations', () => {
  it('preserves in-flight jobs with their missing completion timestamp', async () => {
    const github = new FakeGithub({
      jobsByRun: {
        42: [
          job('QA Metrics / Collect', {
            status: 'in_progress',
            conclusion: null,
            completed_at: null,
          }),
        ],
      },
    });

    const result = await collectCiDurations(github, context, 42);

    expect(result).toEqual({
      runId: 42,
      error: null,
      jobs: [
        {
          name: 'QA Metrics / Collect',
          status: 'in_progress',
          conclusion: null,
          startedAt: '2026-07-25T00:00:00Z',
          completedAt: null,
        },
      ],
    });
  });
});
