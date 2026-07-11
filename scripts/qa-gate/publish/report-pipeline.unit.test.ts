import { describe, expect, it } from 'bun:test';

import { QA_METRICS_ARTIFACT_NAME as TS_ARTIFACT_NAME } from '../metrics-envelope';
import {
  CI_WORKFLOW_FILE,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  QA_METRICS_ARTIFACT_NAME,
  resolveReportInputs,
} from './report-pipeline';

const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

interface FakeArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly size_in_bytes: number;
}

interface FakeOptions {
  readonly pullRequests?: unknown[];
  readonly artifactsByRun?: Record<number, FakeArtifact[]>;
  readonly baselineRuns?: Array<{ id: number; head_sha: string }>;
  readonly archives?: Record<number, Uint8Array>;
}

class FakeGithub {
  readonly downloadedArtifactIds: number[] = [];
  readonly workflowRunQueries: Array<Record<string, unknown>> = [];

  constructor(private readonly options: FakeOptions) {}

  readonly rest = {
    pulls: { list: 'pulls-list-route' },
    actions: {
      listWorkflowRunArtifacts: 'list-artifacts-route',
      downloadArtifact: ({ artifact_id }: { artifact_id: number }) => {
        this.downloadedArtifactIds.push(artifact_id);
        const archive = this.options.archives?.[artifact_id] ?? new Uint8Array([123]);
        return Promise.resolve({ data: archive.buffer });
      },
      listWorkflowRuns: (params: Record<string, unknown>) => {
        this.workflowRunQueries.push(params);
        const runs = (this.options.baselineRuns ?? []).filter(
          (run) => run.head_sha === params.head_sha
        );
        return Promise.resolve({ data: { workflow_runs: runs } });
      },
    },
  };

  paginate = (route: unknown, params: Record<string, unknown>) => {
    if (route === this.rest.pulls.list) {
      return Promise.resolve(this.options.pullRequests ?? []);
    }
    if (route === this.rest.actions.listWorkflowRunArtifacts) {
      return Promise.resolve(this.options.artifactsByRun?.[params.run_id as number] ?? []);
    }
    throw new Error('unexpected paginate route');
  };
}

const context = {
  repo: { owner: 'mango', repo: 'studio' },
  payload: {
    workflow_run: {
      id: 42,
      event: 'pull_request',
      head_sha: HEAD_SHA,
      head_branch: 'feat/thing',
      head_repository: { owner: { login: 'forker' } },
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

describe('artifact name pinning', () => {
  it('matches the TypeScript collector constant', () => {
    expect(QA_METRICS_ARTIFACT_NAME).toBe(TS_ARTIFACT_NAME);
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
      baselineRuns: [{ id: 90, head_sha: BASE_SHA }],
      artifactsByRun: { 42: [artifact(1)], 90: [artifact(2)] },
      archives: { 1: new Uint8Array([104]), 2: new Uint8Array([98]) },
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.skip).toBeNull();
    expect(result.headArchive).toEqual(new Uint8Array([104]));
    expect(result.baseArchive).toEqual(new Uint8Array([98]));
    expect(github.downloadedArtifactIds).toEqual([1, 2]);
    expect(github.workflowRunQueries).toEqual([
      {
        owner: 'mango',
        repo: 'studio',
        workflow_id: CI_WORKFLOW_FILE,
        head_sha: BASE_SHA,
        event: 'push',
        status: 'success',
        per_page: 10,
      },
    ]);
    expect(result.reportContext).toEqual({
      repository: 'mango/studio',
      prNumber: 7,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      runUrl: 'https://example.test/runs/42',
      headArtifact: { found: true, reason: null },
      baseArtifact: { found: true, reason: null },
    });
  });

  it('reports a missing baseline run without approximating it', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1)] },
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.baseArchive).toBeNull();
    expect(result.reportContext.baseArtifact.found).toBe(false);
    expect(result.reportContext.baseArtifact.reason).toContain('no successful main CI run');
  });

  it('rejects oversized artifacts before downloading them', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: {
        42: [artifact(1, { size_in_bytes: MAX_ARTIFACT_ARCHIVE_BYTES + 1 })],
      },
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.headArchive).toBeNull();
    expect(result.reportContext.headArtifact.reason).toContain('exceeds');
    expect(github.downloadedArtifactIds).toEqual([]);
  });

  it('ignores expired artifacts and reports them as missing', async () => {
    const github = new FakeGithub({
      pullRequests: [openPr],
      artifactsByRun: { 42: [artifact(1, { expired: true })] },
    });

    const result = await resolveReportInputs({ github, context });

    expect(result.headArchive).toBeNull();
    expect(result.reportContext.headArtifact.reason).toContain('no qa-metrics artifact');
  });
});
