import { describe, expect, test } from 'bun:test';

import { RUNTIME_REUSE_MARKER_STEP, settleRuntimeReuse } from '../lib/canary-runtime-reuse';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import {
  type RuntimeBaseApi,
  runtimeBuildJobName,
  runtimeReuseArtifactName,
} from '../lib/runtime-base-reuse';

const REPOSITORY = 'owner/repo';
const SOURCE_RUN = 100;
const SOURCE_SHA = 'b'.repeat(40);
const PRODUCER_RUN = 700;
const PRODUCER_SHA = 'a'.repeat(40);
const DIGEST = 'c'.repeat(64);
const BINARY_SHA = 'e'.repeat(64);
const SOURCE = { repository: REPOSITORY, runId: SOURCE_RUN, sourceSha: SOURCE_SHA };
const PLATFORMS = ALL_BINARY_TARGETS.map((target) => target.arch as string);
const REUSED = 'linux-x64';

const API = `repos/${REPOSITORY}/actions`;
const ARTIFACTS_PATH = `${API}/runs/${SOURCE_RUN}/artifacts?per_page=100`;
// The producer is read as attempt 1: `runs/{id}` and `jobs?filter=all` follow later re-runs.
const PRODUCER_ATTEMPT_PATH = `${API}/runs/${PRODUCER_RUN}/attempts/1`;
const PRODUCER_JOBS_PATH = `${API}/runs/${PRODUCER_RUN}/attempts/1/jobs?per_page=100`;
const RECORD_NAME = runtimeReuseArtifactName(REUSED, PRODUCER_RUN, DIGEST, BINARY_SHA);

/** Reads served from a table keyed by the exact path; an unscripted path fails naming it. */
class FakeReuseApi implements RuntimeBaseApi {
  readonly values = new Map<string, unknown>();
  readonly requests: string[] = [];

  get(path: string): unknown {
    this.requests.push(path);
    return this.serve(path);
  }

  list(path: string, key: string): readonly unknown[] {
    this.requests.push(path);
    const body = this.serve(path);
    if (!Array.isArray(body)) {
      throw new Error(`FakeReuseApi: expected an array scripted for ${key} | received: ${path}`);
    }
    return body;
  }

  private serve(path: string): unknown {
    if (!this.values.has(path)) {
      throw new Error(`FakeReuseApi: expected a scripted read | received: ${path}`);
    }
    return this.values.get(path);
  }
}

type Row = Record<string, unknown>;

function runtimeJob(platform: string, steps: readonly Row[] | undefined): Row {
  return {
    id: 5000 + PLATFORMS.indexOf(platform),
    run_id: SOURCE_RUN,
    name: runtimeBuildJobName(platform),
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-28T09:00:00Z',
    completed_at: '2026-11-28T09:10:00Z',
    ...(steps === undefined ? {} : { steps }),
  };
}

const step = (name: string, conclusion: string | null = 'success'): Row => ({
  name,
  status: 'completed',
  conclusion,
});

/** The jobs a run that built everything reports. */
function builtJobs(): { platform: string; job: Row }[] {
  return PLATFORMS.map((platform) => ({
    platform,
    job: runtimeJob(platform, [step('Build runtime')]),
  }));
}

/** The jobs of a run in which `REUSED` skipped cargo; `marker` is the conclusion of its marker step. */
function reusingJobs(marker: string | null = 'success'): { platform: string; job: Row }[] {
  return builtJobs().map((entry) =>
    entry.platform === REUSED
      ? {
          platform: REUSED,
          job: runtimeJob(REUSED, [step(RUNTIME_REUSE_MARKER_STEP, marker), step('Build runtime')]),
        }
      : entry
  );
}

function recordRow(overrides: Row = {}): Row {
  return {
    id: 77,
    name: RECORD_NAME,
    expired: false,
    created_at: '2026-11-28T09:08:00Z',
    workflow_run: { id: SOURCE_RUN },
    ...overrides,
  };
}

/** A source run whose `REUSED` runtime reused a base that passes every producer check. */
function acceptedApi(records: readonly Row[] = [recordRow()]): FakeReuseApi {
  const api = new FakeReuseApi();
  api.values.set(ARTIFACTS_PATH, [
    // Distribution artifacts sit beside the records and are ignored.
    { id: 1, name: `runtime-${SOURCE_SHA}-linux-x64`, expired: false },
    ...records,
  ]);
  api.values.set(PRODUCER_ATTEMPT_PATH, producerRun());
  api.values.set(PRODUCER_JOBS_PATH, [producerJob()]);
  api.values.set(`repos/${REPOSITORY}/compare/${PRODUCER_SHA}...${SOURCE_SHA}`, {
    status: 'ahead',
    base_commit: { sha: PRODUCER_SHA },
    merge_base_commit: { sha: PRODUCER_SHA },
    files: [{ filename: 'README.md' }],
  });
  return api;
}

function producerRun(overrides: Row = {}): Row {
  return {
    id: PRODUCER_RUN,
    run_attempt: 1,
    event: 'push',
    head_branch: 'main',
    head_sha: PRODUCER_SHA,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function producerJob(overrides: Row = {}): Row {
  return {
    id: 7000,
    run_id: PRODUCER_RUN,
    name: runtimeBuildJobName(REUSED),
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-20T09:00:00Z',
    completed_at: '2026-11-20T09:10:00Z',
    ...overrides,
  };
}

function refusalOf(api: RuntimeBaseApi, jobs = reusingJobs()): string {
  try {
    settleRuntimeReuse(api, SOURCE, jobs);
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error('expected a refusal | received: an accepted receipt');
}

describe('settleRuntimeReuse', () => {
  test('a run that built every runtime records them as built and reads no producer', () => {
    const api = new FakeReuseApi();
    api.values.set(ARTIFACTS_PATH, [{ id: 1, name: `runtime-${SOURCE_SHA}-linux-x64` }]);
    expect(settleRuntimeReuse(api, SOURCE, builtJobs())).toEqual({ reused: [], built: PLATFORMS });
    expect(api.requests).toEqual([ARTIFACTS_PATH]);
  });

  test('a skipped marker step is a build, not a reuse', () => {
    const api = new FakeReuseApi();
    api.values.set(ARTIFACTS_PATH, []);
    const receipt = settleRuntimeReuse(api, SOURCE, reusingJobs('skipped'));
    expect(receipt.built).toEqual(PLATFORMS);
    expect(receipt.reused).toEqual([]);
  });

  test('a verified reuse shows the digest, the binary hash and the producing run and commit', () => {
    expect(settleRuntimeReuse(acceptedApi(), SOURCE, reusingJobs())).toEqual({
      reused: [
        {
          platform: REUSED,
          digest: DIGEST,
          binarySha256: BINARY_SHA,
          producerRunId: PRODUCER_RUN,
          producerSha: PRODUCER_SHA,
          recordArtifactId: 77,
        },
      ],
      built: PLATFORMS.filter((platform) => platform !== REUSED),
    });
  });

  test('never reads the producer artifact, which may have expired since, because only the record must live', () => {
    // The unstamped base lives seven days and the record thirty.
    const api = acceptedApi();
    expect(settleRuntimeReuse(api, SOURCE, reusingJobs()).reused).toHaveLength(1);
    expect(api.requests.some((path) => path.includes('runtime-unstamped'))).toBe(false);
  });

  test('accepts a producer run that was cancelled after its build job succeeded', () => {
    const api = acceptedApi();
    api.values.set(PRODUCER_ATTEMPT_PATH, producerRun({ conclusion: 'cancelled' }));
    expect(settleRuntimeReuse(api, SOURCE, reusingJobs()).reused).toHaveLength(1);
  });

  describe('a consuming job that was re-run', () => {
    // Attempt 1 chose producer 701 (record created 08:00, before this job's 09:00 window);
    // the re-run chose PRODUCER_RUN. Their names differ, so both records are listed.
    const attempt1Record = () =>
      recordRow({
        id: 70,
        name: runtimeReuseArtifactName(REUSED, 701, 'd'.repeat(64), BINARY_SHA),
        created_at: '2026-11-28T08:05:00Z',
      });

    test('takes the record created inside the latest attempt job and ignores the earlier one', () => {
      const receipt = settleRuntimeReuse(
        acceptedApi([attempt1Record(), recordRow()]),
        SOURCE,
        reusingJobs()
      );
      expect(receipt.reused.map((entry) => [entry.producerRunId, entry.recordArtifactId])).toEqual([
        [PRODUCER_RUN, 77],
      ]);
    });

    test('a re-run that built from source is not blamed for the earlier attempt record', () => {
      const api = new FakeReuseApi();
      api.values.set(ARTIFACTS_PATH, [attempt1Record()]);
      expect(settleRuntimeReuse(api, SOURCE, builtJobs())).toEqual({
        reused: [],
        built: PLATFORMS,
      });
    });

    test('a re-run that reused but kept only the earlier record is refused', () => {
      expect(refusalOf(acceptedApi([attempt1Record()]))).toContain(
        'expected exactly one, because the job reused a base; received 0'
      );
    });
  });

  test.each([
    [
      'a record whose job never reused a base',
      () => ({ api: acceptedApi(), jobs: builtJobs() }),
      `runtime ${REUSED} reuse record: expected none, because the "${RUNTIME_REUSE_MARKER_STEP}" step did not run`,
    ],
    [
      'a record beside a skipped marker',
      () => ({ api: acceptedApi(), jobs: reusingJobs('skipped') }),
      'expected none, because',
    ],
    [
      'a marker that failed',
      () => ({ api: acceptedApi(), jobs: reusingJobs('failure') }),
      `"${RUNTIME_REUSE_MARKER_STEP}" step conclusion: expected success or skipped; received "failure"`,
    ],
    [
      'a marker without a record',
      () => ({ api: acceptedApi([]), jobs: reusingJobs() }),
      `reuse records of run ${SOURCE_RUN}: expected exactly one, because the job reused a base; received 0`,
    ],
    [
      'two records for one platform',
      () => ({
        api: acceptedApi([
          recordRow(),
          recordRow({
            id: 78,
            name: runtimeReuseArtifactName(REUSED, 701, DIGEST, BINARY_SHA),
          }),
        ]),
        jobs: reusingJobs(),
      }),
      'expected exactly one, because the job reused a base; received 2',
    ],
    [
      'a record with a malformed name',
      () => ({
        api: acceptedApi([recordRow({ name: `runtime-reuse-${REUSED}-xyz` })]),
        jobs: reusingJobs(),
      }),
      'runtime-reuse-<platform>-<producer run>-<digest>-<binary sha256>',
    ],
    [
      'a record for a platform no job builds',
      () => ({
        api: acceptedApi([
          recordRow({ name: `runtime-reuse-plan9-${PRODUCER_RUN}-${DIGEST}-${BINARY_SHA}` }),
        ]),
        jobs: reusingJobs(),
      }),
      'expected runtime-reuse-<platform>',
    ],
    [
      'an expired record',
      () => ({ api: acceptedApi([recordRow({ expired: true })]), jobs: reusingJobs() }),
      'expired: expected false; received true',
    ],
    [
      'a record of another run',
      () => ({
        api: acceptedApi([recordRow({ workflow_run: { id: 999 } })]),
        jobs: reusingJobs(),
      }),
      `workflow_run.id: expected ${SOURCE_RUN}; received 999`,
    ],
    [
      'a record created long after its job finished',
      () => ({
        api: acceptedApi([recordRow({ created_at: '2026-11-28T12:00:00Z' })]),
        jobs: reusingJobs(),
      }),
      // Outside the job's window it is another attempt's record, so this job has none.
      'expected exactly one, because the job reused a base; received 0',
    ],
    [
      'a job without steps',
      () => ({
        api: acceptedApi(),
        jobs: builtJobs().map((entry) =>
          entry.platform === REUSED
            ? { platform: REUSED, job: runtimeJob(REUSED, undefined) }
            : entry
        ),
      }),
      'steps: expected a non-empty array of steps',
    ],
    [
      'a job with the marker step twice',
      () => ({
        api: acceptedApi(),
        jobs: builtJobs().map((entry) =>
          entry.platform === REUSED
            ? {
                platform: REUSED,
                job: runtimeJob(REUSED, [
                  step(RUNTIME_REUSE_MARKER_STEP),
                  step(RUNTIME_REUSE_MARKER_STEP),
                ]),
              }
            : entry
        ),
      }),
      `named ${RUNTIME_REUSE_MARKER_STEP}: expected at most one; received 2`,
    ],
  ])('refuses %s', (_name, scenario, message) => {
    const { api, jobs } = scenario();
    expect(refusalOf(api, jobs)).toContain(message);
  });

  describe('a producer that is not a successful main push build job of this repository', () => {
    test.each([
      ['a pull request run', producerRun({ event: 'pull_request' }), 'event: expected push'],
      ['a dispatched run', producerRun({ event: 'workflow_dispatch' }), 'event: expected push'],
      ['a workflow_run run', producerRun({ event: 'workflow_run' }), 'event: expected push'],
      ['a branch run', producerRun({ head_branch: 'dev' }), 'head_branch: expected main'],
      [
        'another workflow',
        producerRun({ path: '.github/workflows/evil.yml' }),
        'path: expected .github/workflows/ci.yml',
      ],
      [
        'a fork run',
        producerRun({ head_repository: { full_name: 'fork/repo' } }),
        `head_repository: expected ${REPOSITORY}; received "fork/repo"`,
      ],
      ['a re-run', producerRun({ run_attempt: 2 }), 'run_attempt: expected 1 (the attempt read)'],
      ['a run with no commit', producerRun({ head_sha: 'abc' }), 'head_sha: expected 40-character'],
    ])('refuses %s', (_name, run, message) => {
      const api = acceptedApi();
      api.values.set(PRODUCER_ATTEMPT_PATH, run);
      expect(refusalOf(api)).toContain(message);
    });

    test('refuses a producer whose build job failed, was cancelled or ran twice', () => {
      const jobsPath = PRODUCER_JOBS_PATH;
      for (const job of [
        producerJob({ conclusion: 'failure' }),
        producerJob({ conclusion: 'cancelled' }),
        producerJob({ status: 'in_progress', conclusion: null }),
      ]) {
        const api = acceptedApi();
        api.values.set(jobsPath, [job]);
        expect(refusalOf(api)).toContain('status, conclusion and run_id');
      }
      const twice = acceptedApi();
      twice.values.set(jobsPath, [producerJob(), producerJob({ id: 7001 })]);
      expect(refusalOf(twice)).toContain('exactly one');
      const missing = acceptedApi();
      missing.values.set(jobsPath, []);
      expect(refusalOf(missing)).toContain(`jobs named "${runtimeBuildJobName(REUSED)}"`);
    });

    test('refuses the source run itself as its own producer', () => {
      const api = acceptedApi([
        recordRow({
          name: runtimeReuseArtifactName(REUSED, SOURCE_RUN, DIGEST, BINARY_SHA),
        }),
      ]);
      expect(refusalOf(api)).toContain(`a run other than ${SOURCE_RUN}`);
    });

    test('refuses a producer commit that is not an ancestor of the source', () => {
      const api = acceptedApi();
      api.values.set(`repos/${REPOSITORY}/compare/${PRODUCER_SHA}...${SOURCE_SHA}`, {
        status: 'diverged',
        base_commit: { sha: PRODUCER_SHA },
        merge_base_commit: { sha: 'f'.repeat(40) },
        files: [],
      });
      expect(refusalOf(api)).toContain('status: expected ahead or identical');
    });

    test('refuses a producer whose runtime inputs differ from the source', () => {
      const api = acceptedApi();
      api.values.set(`repos/${REPOSITORY}/compare/${PRODUCER_SHA}...${SOURCE_SHA}`, {
        status: 'ahead',
        base_commit: { sha: PRODUCER_SHA },
        merge_base_commit: { sha: PRODUCER_SHA },
        files: [{ filename: 'README.md' }, { filename: 'Cargo.lock' }],
      });
      expect(refusalOf(api)).toContain('changed path: expected no runtime input path');
    });
  });
});
