import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectRuntimeInputs, stageUnstampedRuntime } from '../ci/runtime-input-digest';
import {
  buildRuntimeReuseRecord,
  parseRuntimeReuseArtifactName,
  renderRuntimeBaseRefusalSummary,
  renderRuntimeReuseSummary,
  resolveRuntimeBase,
  type RuntimeBaseApi,
  runtimeBaseContextProblem,
  type RuntimeBaseDeps,
  type RuntimeBaseRequest,
  runtimeBuildJobName,
  runtimeReuseArtifactName,
  verifyProducerRun,
  verifyRuntimeBaseFiles,
} from '../lib/runtime-base-reuse';
import { unstampedArtifactName } from '../lib/runtime-input-digest';
import {
  RELEASE_STAMP_MAGIC,
  RELEASE_STAMP_SLOT_BYTES,
  stampReleaseVersion,
} from '../lib/runtime-stamp';
import { sha256OfBytes } from '../lib/script-guards';
import { fakeElf, fakePe, withTail } from './support/executable-fixtures';
import {
  FakeGit,
  FakeToolRunner,
  indexOf,
  MINIMAL_RUNTIME_TREE,
} from './support/fake-runtime-input-tools';
import { useScratchDirs } from './support/scratch-dirs';

const makeScratchDir = useScratchDirs();

const REPOSITORY = 'owner/repo';
const PRODUCER_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(40);
const CURRENT_RUN = 900;
const PRODUCER_RUN = 700;
const NOW = Date.parse('2026-11-28T10:00:00Z');
const DIGEST = 'c'.repeat(64);
const ARTIFACT_NAME = unstampedArtifactName('linux-x64', DIGEST);

const REQUEST: RuntimeBaseRequest = {
  repository: REPOSITORY,
  platform: 'linux-x64',
  profile: 'shipping',
  digest: DIGEST,
  sourceSha: SOURCE_SHA,
  currentRunId: CURRENT_RUN,
  eventName: 'push',
  ref: 'refs/heads/main',
};
const DEPS: RuntimeBaseDeps = {
  now: () => NOW,
  bounds: { maxRuns: 100, maxCandidates: 5, budgetMs: 60_000 },
};

const RUNS_PATH = `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=100`;
const NOMINATION_PATH = `repos/${REPOSITORY}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100`;
const jobsPath = (runId: number) =>
  `repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`;
const runArtifactsPath = (runId: number) =>
  `repos/${REPOSITORY}/actions/runs/${runId}/artifacts?name=${ARTIFACT_NAME}&per_page=100`;
const comparePath = (sha: string) => `repos/${REPOSITORY}/compare/${sha}...${SOURCE_SHA}`;

/**
 * The GitHub reads of the resolver, served from a table keyed by the exact
 * request path. A path nobody scripted fails naming it, so a changed request
 * shows as a test failure and not as a silent refusal.
 */
class FakeRuntimeBaseApi implements RuntimeBaseApi {
  readonly requests: string[] = [];
  readonly values = new Map<string, unknown>();
  readonly failures = new Map<string, string>();

  get(path: string): unknown {
    this.requests.push(path);
    return this.serve(path);
  }

  list(path: string, key: string): readonly unknown[] {
    this.requests.push(path);
    const body = this.serve(path);
    if (!Array.isArray(body)) {
      throw new Error(
        `FakeRuntimeBaseApi: expected an array scripted for ${key} | received: ${path}`
      );
    }
    return body;
  }

  private serve(path: string): unknown {
    const failure = this.failures.get(path);
    if (failure !== undefined) throw new Error(failure);
    if (!this.values.has(path)) {
      throw new Error(`FakeRuntimeBaseApi: expected a scripted read | received: ${path}`);
    }
    return this.values.get(path);
  }
}

function runRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    run_number: id,
    run_attempt: 1,
    event: 'push',
    head_branch: 'main',
    head_sha: PRODUCER_SHA,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'cancelled',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function jobRow(runId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: runId * 10,
    run_id: runId,
    name: runtimeBuildJobName('linux-x64'),
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-28T09:03:32Z',
    completed_at: '2026-11-28T09:08:04Z',
    ...overrides,
  };
}

function artifactRow(
  runId: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: runId * 100,
    name: ARTIFACT_NAME,
    expired: false,
    created_at: '2026-11-28T09:08:02Z',
    expires_at: '2026-12-05T09:08:01Z',
    digest: `sha256:${'d'.repeat(64)}`,
    workflow_run: {
      id: runId,
      head_branch: 'main',
      head_sha: PRODUCER_SHA,
      repository_id: 1191468357,
      head_repository_id: 1191468357,
    },
    ...overrides,
  };
}

/** One producer run that passes every check; each test breaks one thing. */
function acceptedApi(runId = PRODUCER_RUN): FakeRuntimeBaseApi {
  const api = new FakeRuntimeBaseApi();
  api.values.set(RUNS_PATH, { workflow_runs: [runRow(runId)] });
  api.values.set(NOMINATION_PATH, { artifacts: [artifactRow(runId)] });
  api.values.set(jobsPath(runId), [jobRow(runId)]);
  api.values.set(comparePath(PRODUCER_SHA), {
    status: 'ahead',
    base_commit: { sha: PRODUCER_SHA },
    merge_base_commit: { sha: PRODUCER_SHA },
    files: [{ filename: 'README.md' }],
  });
  api.values.set(runArtifactsPath(runId), { artifacts: [artifactRow(runId)] });
  return api;
}

function refusalOf(api: RuntimeBaseApi, request = REQUEST, deps = DEPS): string {
  const verdict = resolveRuntimeBase(api, request, deps);
  if (verdict.reuse)
    throw new Error(`expected a refusal | received: reuse of run ${verdict.producer.runId}`);
  return verdict.reason;
}

describe('resolveRuntimeBase', () => {
  test('accepts a producer whose job succeeded although its run was cancelled', () => {
    const verdict = resolveRuntimeBase(acceptedApi(), REQUEST, DEPS);
    expect(verdict).toEqual({
      reuse: true,
      producer: {
        runId: PRODUCER_RUN,
        runAttempt: 1,
        sha: PRODUCER_SHA,
        jobId: PRODUCER_RUN * 10,
        jobStartedAtMs: Date.parse('2026-11-28T09:03:32Z'),
        jobCompletedAtMs: Date.parse('2026-11-28T09:08:04Z'),
      },
      artifact: {
        id: PRODUCER_RUN * 100,
        name: ARTIFACT_NAME,
        archiveDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
  });

  test('accepts a producer run that is still in progress once its job has finished', () => {
    const api = acceptedApi();
    api.values.set(RUNS_PATH, {
      workflow_runs: [runRow(PRODUCER_RUN, { status: 'in_progress', conclusion: null })],
    });
    expect(resolveRuntimeBase(api, REQUEST, DEPS).reuse).toBe(true);
  });

  test('accepts the checkout being the producer commit (identical compare)', () => {
    const api = acceptedApi();
    api.values.set(comparePath(PRODUCER_SHA), {
      status: 'identical',
      base_commit: { sha: PRODUCER_SHA },
      merge_base_commit: { sha: PRODUCER_SHA },
      files: [],
    });
    expect(resolveRuntimeBase(api, REQUEST, DEPS).reuse).toBe(true);
  });

  test.each([
    [
      'a pull request',
      { eventName: 'pull_request' },
      'expected event push | received: pull_request',
    ],
    ['a dispatch', { eventName: 'workflow_dispatch' }, 'received: workflow_dispatch'],
    [
      'a tag push',
      { ref: 'refs/tags/v1.2.3' },
      'expected ref refs/heads/main | received: refs/tags/v1.2.3',
    ],
    ['a branch push', { ref: 'refs/heads/feature' }, 'received: refs/heads/feature'],
    ['the light profile', { profile: 'light' }, 'expected profile shipping | received: light'],
    [
      'an unknown platform',
      { platform: 'linux-riscv' },
      'expected a release platform id | received: linux-riscv',
    ],
    ['a short digest', { digest: 'abc' }, 'expected a 64-character hex digest | received: "abc"'],
    [
      'a short source sha',
      { sourceSha: 'abc' },
      'expected a 40-character source SHA | received: "abc"',
    ],
    ['a zero run id', { currentRunId: 0 }, 'expected a positive current run id | received: 0'],
  ])('refuses %s before any read', (_name, override, reason) => {
    const api = new FakeRuntimeBaseApi();
    expect(refusalOf(api, { ...REQUEST, ...override })).toContain(reason);
    expect(api.requests).toEqual([]);
  });

  test('refuses when no listed run has the artifact, and says how many it looked at', () => {
    const api = acceptedApi();
    api.values.set(NOMINATION_PATH, { artifacts: [] });
    expect(refusalOf(api)).toBe(
      `no run among the newest 1 main push runs of ci.yml has an unexpired artifact ${ARTIFACT_NAME}`
    );
  });

  test('never trusts an artifact whose run is not in the main push listing (a forged name)', () => {
    const api = acceptedApi();
    // A pull request run stored an artifact under the real name; it is not a listed main push run.
    api.values.set(NOMINATION_PATH, { artifacts: [artifactRow(555)] });
    expect(refusalOf(api)).toContain('has an unexpired artifact');
    expect(api.requests).not.toContain(jobsPath(555));
  });

  test('a pull request row smuggled into the listing is dropped, not verified', () => {
    const api = acceptedApi();
    api.values.set(RUNS_PATH, { workflow_runs: [runRow(PRODUCER_RUN, { event: 'pull_request' })] });
    expect(refusalOf(api)).toContain('has an unexpired artifact');
  });

  test.each([
    ['another workflow file', { path: '.github/workflows/evil.yml' }, 'path'],
    ['a different event', { event: 'workflow_dispatch' }, 'event'],
    ['another branch', { head_branch: 'feature' }, 'head_branch'],
    ['a fork head repository', { head_repository: { full_name: 'fork/repo' } }, 'head_repository'],
    ['another repository', { repository: { full_name: 'other/repo' } }, 'repository'],
    ['a re-run attempt', { run_attempt: 2 }, 'run_attempt'],
    ['a malformed head sha', { head_sha: 'abc' }, 'head_sha'],
  ])('refuses a producer run with %s', (_name, override, field) => {
    const api = acceptedApi();
    // `event` and `head_branch` are also what the listing filters on; the others reach verification.
    api.values.set(RUNS_PATH, {
      workflow_runs: [runRow(PRODUCER_RUN, override)],
    });
    api.values.set(NOMINATION_PATH, { artifacts: [artifactRow(PRODUCER_RUN)] });
    const reason = refusalOf(api);
    expect(reason).toMatch(new RegExp(`${field}|has an unexpired artifact`));
  });

  test('refuses the run being built itself, so a re-run cannot nominate its own artifact', () => {
    const api = acceptedApi(CURRENT_RUN);
    expect(refusalOf(api)).toContain(`a run other than ${CURRENT_RUN}`);
  });

  test.each([
    ['failed', { conclusion: 'failure' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['still running', { status: 'in_progress', conclusion: null }],
    ['skipped', { conclusion: 'skipped' }],
    ['of another run', { run_id: 1 }],
  ])('refuses a producer whose build job is %s', (_name, override) => {
    const api = acceptedApi();
    api.values.set(jobsPath(PRODUCER_RUN), [jobRow(PRODUCER_RUN, override)]);
    expect(refusalOf(api)).toContain(`job "${runtimeBuildJobName('linux-x64')}"`);
  });

  test('refuses a producer whose build job ran as attempt 2', () => {
    const api = acceptedApi();
    api.values.set(jobsPath(PRODUCER_RUN), [jobRow(PRODUCER_RUN, { run_attempt: 2 })]);
    expect(refusalOf(api)).toContain('job run_attempt: expected 1; received 2');
  });

  test('refuses a producer with no build job for the platform, or two', () => {
    const api = acceptedApi();
    api.values.set(jobsPath(PRODUCER_RUN), [
      jobRow(PRODUCER_RUN, { name: runtimeBuildJobName('linux-arm64') }),
    ]);
    expect(refusalOf(api)).toContain('exactly one');
    api.values.set(jobsPath(PRODUCER_RUN), [jobRow(PRODUCER_RUN), jobRow(PRODUCER_RUN, { id: 1 })]);
    expect(refusalOf(api)).toContain('exactly one');
  });

  test.each([
    ['diverged', { status: 'diverged' }, 'ahead or identical'],
    ['behind', { status: 'behind' }, 'ahead or identical'],
    ['a different merge base', { merge_base_commit: { sha: 'e'.repeat(40) } }, 'merge_base_commit'],
    ['truncated', { truncated: true }, 'truncated'],
    [
      'a runtime source change',
      { files: [{ filename: 'crates/mangostudio-runtime/src/main.rs' }] },
      'no runtime input path',
    ],
    [
      'a renamed-away runtime input',
      { files: [{ filename: 'docs/x.rs', previous_filename: 'Cargo.lock' }] },
      'no runtime input path',
    ],
    ['a lockfile change', { files: [{ filename: 'Cargo.lock' }] }, 'no runtime input path'],
    [
      '300 files',
      {
        files: Array.from({ length: 300 }, (_unused, index) => ({ filename: `docs/${index}.md` })),
      },
      'fewer than 300',
    ],
  ])('refuses a producer commit whose compare is %s', (_name, override, reason) => {
    const api = acceptedApi();
    api.values.set(comparePath(PRODUCER_SHA), {
      status: 'ahead',
      base_commit: { sha: PRODUCER_SHA },
      merge_base_commit: { sha: PRODUCER_SHA },
      files: [],
      ...override,
    });
    expect(refusalOf(api)).toContain(reason);
  });

  test('accepts a change outside the runtime inputs between producer and checkout', () => {
    const api = acceptedApi();
    api.values.set(comparePath(PRODUCER_SHA), {
      status: 'ahead',
      base_commit: { sha: PRODUCER_SHA },
      merge_base_commit: { sha: PRODUCER_SHA },
      files: [
        { filename: 'crates/mangostudio-runtime/tests/it/layout.rs' },
        { filename: 'apps/api/src/index.ts' },
      ],
    });
    expect(resolveRuntimeBase(api, REQUEST, DEPS).reuse).toBe(true);
  });

  test.each([
    ['expired', { expired: true }, 'expired'],
    ['past its expiry time', { expires_at: '2026-11-28T09:59:59Z' }, 'expires_at'],
    ['without a digest', { digest: null }, 'digest'],
    ['with a malformed digest', { digest: 'sha1:abc' }, 'digest'],
    ['created before its job started', { created_at: '2026-11-28T08:00:00Z' }, 'created_at'],
    ['created after its job ended', { created_at: '2026-11-28T09:30:00Z' }, 'created_at'],
  ])('refuses an artifact that is %s', (_name, override, reason) => {
    const api = acceptedApi();
    api.values.set(runArtifactsPath(PRODUCER_RUN), {
      artifacts: [artifactRow(PRODUCER_RUN, override)],
    });
    expect(refusalOf(api)).toContain(reason);
  });

  test.each([
    ['another run', { id: 1 }],
    ['another branch', { head_branch: 'feature' }],
    ['another commit', { head_sha: 'e'.repeat(40) }],
    ['a fork', { head_repository_id: 7 }],
  ])('refuses an artifact whose workflow_run is %s', (_name, override) => {
    const api = acceptedApi();
    const row = artifactRow(PRODUCER_RUN);
    api.values.set(runArtifactsPath(PRODUCER_RUN), {
      artifacts: [{ ...row, workflow_run: { ...(row.workflow_run as object), ...override } }],
    });
    expect(refusalOf(api)).toContain('workflow_run');
  });

  test('refuses a run that holds the artifact name twice or not at all', () => {
    const api = acceptedApi();
    api.values.set(runArtifactsPath(PRODUCER_RUN), {
      artifacts: [artifactRow(PRODUCER_RUN), artifactRow(PRODUCER_RUN, { id: 1 })],
    });
    expect(refusalOf(api)).toContain('exactly one');
    api.values.set(runArtifactsPath(PRODUCER_RUN), { artifacts: [] });
    expect(refusalOf(api)).toContain('exactly one');
  });

  test('falls back to an older run when the newest candidate fails verification', () => {
    const api = acceptedApi(PRODUCER_RUN);
    const newer = PRODUCER_RUN + 50;
    api.values.set(RUNS_PATH, { workflow_runs: [runRow(newer), runRow(PRODUCER_RUN)] });
    api.values.set(NOMINATION_PATH, { artifacts: [artifactRow(newer), artifactRow(PRODUCER_RUN)] });
    api.values.set(jobsPath(newer), [jobRow(newer, { conclusion: 'failure' })]);
    const verdict = resolveRuntimeBase(api, REQUEST, DEPS);
    expect(verdict.reuse && verdict.producer.runId).toBe(PRODUCER_RUN);
    expect(api.requests.indexOf(jobsPath(newer))).toBeLessThan(
      api.requests.indexOf(jobsPath(PRODUCER_RUN))
    );
  });

  test('verifies at most maxCandidates nominated runs, newest first', () => {
    const api = new FakeRuntimeBaseApi();
    const ids = [30, 29, 28, 27];
    api.values.set(RUNS_PATH, { workflow_runs: ids.map((id) => runRow(id)) });
    api.values.set(NOMINATION_PATH, { artifacts: ids.map((id) => artifactRow(id)) });
    for (const id of ids) api.values.set(jobsPath(id), [jobRow(id, { conclusion: 'failure' })]);
    const reason = refusalOf(api, REQUEST, {
      ...DEPS,
      bounds: { ...DEPS.bounds, maxCandidates: 2 },
    });
    expect(api.requests.filter((path) => path.includes('/jobs?'))).toEqual([
      jobsPath(30),
      jobsPath(29),
    ]);
    expect(reason).toContain('candidate run 30');
    expect(reason).not.toContain('candidate run 28');
  });

  test('stops starting candidates once the time budget is spent', () => {
    const api = new FakeRuntimeBaseApi();
    api.values.set(RUNS_PATH, { workflow_runs: [runRow(30), runRow(29)] });
    api.values.set(NOMINATION_PATH, { artifacts: [artifactRow(30), artifactRow(29)] });
    api.values.set(jobsPath(30), [jobRow(30, { conclusion: 'failure' })]);
    let clock = NOW;
    const slowDeps: RuntimeBaseDeps = {
      bounds: DEPS.bounds,
      // Every read of the clock costs 40 s: the first candidate fits, the second does not.
      now: () => {
        const reading = clock;
        clock += 40_000;
        return reading;
      },
    };
    const reason = refusalOf(api, REQUEST, slowDeps);
    expect(reason).toContain('time budget of 60000 ms spent');
    expect(api.requests).not.toContain(jobsPath(29));
  });

  test('every API error is a refusal that names the request, never a throw', () => {
    for (const path of [
      RUNS_PATH,
      NOMINATION_PATH,
      jobsPath(PRODUCER_RUN),
      comparePath(PRODUCER_SHA),
      runArtifactsPath(PRODUCER_RUN),
    ]) {
      const api = acceptedApi();
      api.failures.set(path, `GitHub API GET ${path}: exit 1 | stderr: HTTP 502`);
      expect(refusalOf(api)).toContain('HTTP 502');
    }
  });

  test.each([
    ['a listing that is not an object', RUNS_PATH, 'nope', 'workflow run listing'],
    ['a listing without workflow_runs', RUNS_PATH, {}, 'workflow_runs'],
    ['a nomination listing without artifacts', NOMINATION_PATH, { total_count: 0 }, 'artifacts'],
    ['a run artifact listing that is null', runArtifactsPath(PRODUCER_RUN), null, 'artifacts'],
    [
      'a compare without files',
      comparePath(PRODUCER_SHA),
      {
        status: 'ahead',
        base_commit: { sha: PRODUCER_SHA },
        merge_base_commit: { sha: PRODUCER_SHA },
      },
      'files',
    ],
  ])('refuses %s', (_name, path, body, reason) => {
    const api = acceptedApi();
    api.values.set(path, body);
    expect(refusalOf(api)).toContain(reason);
  });
});

describe('verifyProducerRun', () => {
  test('is the check Canary reuses: it accepts a listed record and names the failing field', () => {
    const api = acceptedApi();
    const scope = {
      repository: REPOSITORY,
      platform: 'linux-x64',
      sourceSha: SOURCE_SHA,
      excludeRunId: 1,
    };
    expect(verifyProducerRun(api, scope, runRow(PRODUCER_RUN)).runId).toBe(PRODUCER_RUN);
    expect(() =>
      verifyProducerRun(api, scope, runRow(PRODUCER_RUN, { event: 'pull_request' }))
    ).toThrow('Invalid producer run 700 event: expected push; received "pull_request"');
  });
});

describe('runtimeBaseContextProblem', () => {
  test('is null for a main push of the shipping profile', () => {
    expect(runtimeBaseContextProblem(REQUEST)).toBeNull();
  });
});

// Real stage-2 output: the writer's own files are what a download hands the verifier.
describe('verifyRuntimeBaseFiles', () => {
  const PRODUCER = {
    runId: '42',
    runAttempt: '1',
    sha: 'a'.repeat(40),
    sourceSha: 'a'.repeat(40),
    repository: REPOSITORY,
    runner: { ImageVersion: '20260101.1' },
  };
  const EXPECTED_PRODUCER = {
    runId: 42,
    runAttempt: 1,
    sha: 'a'.repeat(40),
    repository: REPOSITORY,
  };
  const GNU_LOADER = '/lib64/ld-linux-x86-64.so.2';

  function unstamped(interpreter: string | null = GNU_LOADER): Uint8Array {
    const slot = new Uint8Array(RELEASE_STAMP_SLOT_BYTES);
    slot.set(RELEASE_STAMP_MAGIC, 0);
    return withTail(fakeElf({ arch: 'x64', interpreter }), slot);
  }

  function collected(platform = 'linux-x64') {
    return collectRuntimeInputs(
      new FakeGit(indexOf(MINIMAL_RUNTIME_TREE)),
      { platform, profile: 'shipping', zig: true, allowDirty: false },
      new FakeToolRunner().run,
      {}
    );
  }

  /** Writes the two files the stage-2 upload holds, then lets the test damage them. */
  function stageBase(bytes: Uint8Array = unstamped(), platform = 'linux-x64') {
    const root = makeScratchDir('runtime-base-');
    const cargoOutput = join(root, 'cargo-output');
    writeFileSync(cargoOutput, bytes);
    const inputs = collected(platform);
    const base = join(root, 'base');
    const staged = stageUnstampedRuntime({
      cargoOutput,
      outDir: base,
      binaryName: 'mangostudio-runtime',
      inputs,
      producer: PRODUCER,
    });
    return {
      base,
      staged,
      expected: {
        platform,
        profile: 'shipping',
        digest: inputs.digest,
        zig: true,
        producer: EXPECTED_PRODUCER,
      },
    };
  }

  /** The receipt fields the cases below damage. */
  interface ReceiptJson {
    digest: string;
    profile: string;
    schema: string;
    dirty?: string[];
    target: { platform: string; triple: string };
    producer: Record<string, string>;
    binary: { name: string; sha256: string; bytes: number };
    manifest: {
      files: { path: string; blob: string }[];
      facts: { tools: Record<string, string> } & Record<string, unknown>;
    };
  }
  type ReceiptChange = (receipt: ReceiptJson) => void;

  function rewriteReceipt(base: string, change: ReceiptChange): void {
    const path = join(base, 'receipt.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as ReceiptJson;
    change(receipt);
    writeFileSync(path, JSON.stringify(receipt));
  }

  /** Replace the binary and make the receipt vouch for the new bytes, as a forger would. */
  function forgeBinary(base: string, bytes: Uint8Array): void {
    writeFileSync(join(base, 'mangostudio-runtime'), bytes);
    rewriteReceipt(base, (receipt) => {
      receipt.binary.sha256 = sha256OfBytes(bytes);
      receipt.binary.bytes = bytes.length;
    });
  }

  test('accepts the files the stage-2 writer produced and reports the binary hash', () => {
    const { base, staged, expected } = stageBase();
    const verified = verifyRuntimeBaseFiles(base, expected);
    expect(verified).toEqual({
      binaryPath: join(base, 'mangostudio-runtime'),
      binaryName: 'mangostudio-runtime',
      sha256: staged.receipt.binary.sha256,
      bytes: staged.receipt.binary.bytes,
    });
  });

  test('accepts a static musl target with its own triple', () => {
    const { base, expected } = stageBase(unstamped(null), 'linux-x64-musl');
    expect(verifyRuntimeBaseFiles(base, expected).binaryName).toBe('mangostudio-runtime');
  });

  const RECEIPT_DAMAGE: ReadonlyArray<readonly [string, ReceiptChange, string]> = [
    ['digest', (receipt) => void (receipt.digest = 'e'.repeat(64)), 'receipt digest'],
    ['profile', (receipt) => void (receipt.profile = 'light'), 'receipt profile'],
    ['platform', (receipt) => void (receipt.target.platform = 'linux-arm64'), 'receipt target'],
    [
      'triple',
      (receipt) => void (receipt.target.triple = 'aarch64-unknown-linux-gnu'),
      'receipt target',
    ],
    [
      'producer run id',
      (receipt) => void (receipt.producer.runId = '43'),
      'receipt producer.runId',
    ],
    [
      'producer attempt',
      (receipt) => void (receipt.producer.runAttempt = '2'),
      'receipt producer.runAttempt',
    ],
    [
      'producer sha',
      (receipt) => void (receipt.producer.sha = 'f'.repeat(40)),
      'receipt producer.sha',
    ],
    [
      'producer repository',
      (receipt) => void (receipt.producer.repository = 'fork/repo'),
      'receipt producer.repository',
    ],
    ['schema', (receipt) => void (receipt.schema = 'v2'), 'receipt schema'],
    [
      'binary sha256',
      (receipt) => void (receipt.binary.sha256 = '0'.repeat(64)),
      'binary bytes and SHA-256',
    ],
    ['binary size', (receipt) => void (receipt.binary.bytes = 1), 'binary bytes and SHA-256'],
    ['binary name', (receipt) => void (receipt.binary.name = 'other'), 'receipt binary name'],
    ['an extra key', (receipt) => void (receipt.dirty = ['Cargo.lock']), 'receipt keys'],
    [
      'a manifest file blob',
      (receipt) => void (receipt.manifest.files[0] = { path: 'Cargo.toml', blob: 'f'.repeat(40) }),
      'digest of the receipt manifest',
    ],
    [
      'a manifest tool version',
      (receipt) => void (receipt.manifest.facts.tools.rustc = 'rustc 9'),
      'digest of the receipt manifest',
    ],
    [
      'a manifest fact key',
      (receipt) => void (receipt.manifest.facts.extra = 'x'),
      'receipt manifest facts keys',
    ],
  ];

  test.each(RECEIPT_DAMAGE)('refuses a receipt with a changed %s', (_name, change, reason) => {
    const { base, expected } = stageBase();
    rewriteReceipt(base, change);
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow(reason);
  });

  test('refuses a receipt that is not JSON, and a directory without one', () => {
    const { base, expected } = stageBase();
    writeFileSync(join(base, 'receipt.json'), 'not json');
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow(
      'Invalid receipt.json: expected a JSON object'
    );
    const empty = makeScratchDir('runtime-base-empty-');
    expect(() => verifyRuntimeBaseFiles(empty, expected)).toThrow('base directory entries');
  });

  test('refuses a binary whose bytes differ from the receipt', () => {
    const { base, expected } = stageBase();
    const path = join(base, 'mangostudio-runtime');
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0])]));
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow('binary bytes and SHA-256');
  });

  test('refuses a stamped binary even when its receipt hashes it', () => {
    const stamped = unstamped();
    stampReleaseVersion(stamped, '0.1.1');
    const { base, expected } = stageBase();
    // The stage-2 writer refuses to stage a stamped binary, so forge the pair by hand.
    forgeBinary(base, stamped);
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow(
      'Invalid binary release stamp: expected unstamped; received "0.1.1"'
    );
  });

  test('refuses a binary of the wrong format for the target', () => {
    const slot = new Uint8Array(RELEASE_STAMP_SLOT_BYTES);
    slot.set(RELEASE_STAMP_MAGIC, 0);
    const { base, expected } = stageBase(withTail(fakePe('x64'), slot));
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow('binary executable header');
  });

  test('refuses a binary without a stamp slot', () => {
    const { base, expected } = stageBase();
    forgeBinary(base, fakeElf({ arch: 'x64', interpreter: GNU_LOADER }));
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow('exactly 1 release stamp slot');
  });

  test('refuses a stray file beside the base', () => {
    const { base, expected } = stageBase();
    writeFileSync(join(base, 'extra.sh'), '#!/bin/sh');
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow('base directory entries');
  });

  test('refuses a directory where the binary should be a file', () => {
    const { base, expected } = stageBase();
    const path = join(base, 'mangostudio-runtime');
    writeFileSync(path, '');
    mkdirSync(join(base, 'sub'));
    expect(() => verifyRuntimeBaseFiles(base, expected)).toThrow('base directory entries');
  });

  test('refuses an expectation for a platform that has no target', () => {
    const { base, expected } = stageBase();
    expect(() => verifyRuntimeBaseFiles(base, { ...expected, platform: 'plan9' })).toThrow(
      'Invalid platform: expected one of'
    );
  });
});

describe('reuse record', () => {
  test('names the platform, the producing run and the digest, and parses back', () => {
    const name = runtimeReuseArtifactName('linux-x64-musl', 46128211509, DIGEST);
    expect(name).toBe(`runtime-reuse-linux-x64-musl-46128211509-${DIGEST}`);
    expect(parseRuntimeReuseArtifactName(name)).toEqual({
      platform: 'linux-x64-musl',
      producerRunId: 46128211509,
      digest: DIGEST,
    });
    // `linux-x64` is a prefix of `linux-x64-musl`; the digit run after it decides.
    expect(parseRuntimeReuseArtifactName(`runtime-reuse-linux-x64-7-${DIGEST}`)).toMatchObject({
      platform: 'linux-x64',
      producerRunId: 7,
    });
  });

  test.each([
    `runtime-unstamped-linux-x64-${'c'.repeat(64)}`,
    `runtime-reuse-plan9-7-${'c'.repeat(64)}`,
    `runtime-reuse-linux-x64-0-${'c'.repeat(64)}`,
    `runtime-reuse-linux-x64-07-${'c'.repeat(64)}`,
    `runtime-reuse-linux-x64-7-${'C'.repeat(64)}`,
    `runtime-reuse-linux-x64-7-${'c'.repeat(63)}`,
    `runtime-reuse-linux-x64-7-${'c'.repeat(64)}-extra`,
    `runtime-reuse-linux-x64-99999999999999999999-${'c'.repeat(64)}`,
    '',
  ])('does not parse %p', (name) => {
    expect(parseRuntimeReuseArtifactName(name)).toBeNull();
  });

  test('refuses to name a record for an invalid input', () => {
    expect(() => runtimeReuseArtifactName('plan9', 7, DIGEST)).toThrow('Invalid platform');
    expect(() => runtimeReuseArtifactName('linux-x64', 0, DIGEST)).toThrow('producer run id');
    expect(() => runtimeReuseArtifactName('linux-x64', 7, 'abc')).toThrow('Invalid digest');
  });

  test('keeps the original producer and records the reusing run apart from it', () => {
    const verdict = resolveRuntimeBase(acceptedApi(), REQUEST, DEPS);
    if (!verdict.reuse) throw new Error(`expected reuse | received: ${verdict.reason}`);
    const record = buildRuntimeReuseRecord({
      request: REQUEST,
      producer: verdict.producer,
      artifact: verdict.artifact,
      base: {
        binaryPath: '/x',
        binaryName: 'mangostudio-runtime',
        sha256: 'e'.repeat(64),
        bytes: 10,
      },
      reusedBy: { repository: REPOSITORY, runId: CURRENT_RUN, runAttempt: 1, sha: SOURCE_SHA },
    });
    expect(record.producer).toMatchObject({
      runId: PRODUCER_RUN,
      sha: PRODUCER_SHA,
      artifactName: ARTIFACT_NAME,
    });
    expect(record.reusedBy).toEqual({
      repository: REPOSITORY,
      runId: CURRENT_RUN,
      runAttempt: 1,
      sha: SOURCE_SHA,
    });
    expect(record.producer.runId).not.toBe(record.reusedBy.runId);
    const summary = renderRuntimeReuseSummary(record, 'https://github.com');
    expect(summary).toContain(`reused (cargo skipped)`);
    expect(summary).toContain(`\`${'e'.repeat(64)}\``);
    expect(summary).toContain(
      `[${PRODUCER_RUN}](https://github.com/${REPOSITORY}/actions/runs/${PRODUCER_RUN})`
    );
    expect(summary).toContain(
      `[${CURRENT_RUN}](https://github.com/${REPOSITORY}/actions/runs/${CURRENT_RUN})`
    );
  });

  test('a refusal summary says the job built from source and why', () => {
    expect(renderRuntimeBaseRefusalSummary('linux-x64', 'no run\nfound')).toBe(
      '### Runtime base linux-x64: built from source\n\nReuse was on but no verified base was found. Reason: no run found\n'
    );
  });
});
