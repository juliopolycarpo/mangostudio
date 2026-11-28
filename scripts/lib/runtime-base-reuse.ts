// Stage 4 of issue #2698: decide whether a main push may reuse an unstamped
// runtime that an earlier main push already built, instead of running cargo.
//
// Everything here answers one question, "is this base provably the bytes this
// checkout would compile?", and every doubt answers no. The caller then builds
// from source exactly as before, so a refusal costs time and nothing else.
//
// What makes a base acceptable (each point is a check below, none is optional):
//
//   1. It is found by listing the CI workflow's main push runs of this
//      repository, never by artifact name. Names are forgeable: pull request and
//      fork runs store artifacts in this repository under any name they like.
//      The artifact search only NOMINATES run ids; a nominated run counts only
//      when it is also in the run listing and passes `verifyProducerRun`.
//   2. The producing BUILD JOB succeeded, not necessarily the whole run. Main
//      cancels the previous run whenever a push lands, so the newest finished
//      runtime of a busy day usually sits in a cancelled run whose runtime jobs
//      completed. A job that concluded `success` ran every step of the build and
//      the upload; a later failure of an unrelated lane says nothing about those
//      bytes, and Canary independently demands a fully green run before it
//      promotes anything.
//   3. The run and its jobs are read as attempt 1 (`attempts/1`), which a later
//      re-run cannot change, so the jobs and the artifact belong to the same
//      attempt; the artifact's creation time falls inside that job's window,
//      which refuses a base that only an attempt 2 produced.
//   4. The producer commit is an ancestor of the checkout (compare API) and no
//      runtime input path changed between them, a second opinion on the digest
//      that does not share its code.
//   5. After download the receipt parses strictly and re-derives its own digest
//      from its manifest; producer, platform, profile and triple equal the
//      request; the binary's SHA-256 equals the receipt's; the header is the
//      target's own format; the binary carries no release stamp. The ZIP's SHA-256
//      equals the digest the artifact API recorded at upload; the download
//      mechanism (`run-artifact.ts`) enforces that before extraction.
//
// Reads go through the synchronous `get`/`list` port the canary qualifiers use.
// Nothing here throws out of `resolveRuntimeBase`: a failed read or a payload of
// the wrong shape is a reason.
//
// Dependency-free (Node built-ins and sibling scripts): the runtime build job
// runs it with `bun --no-install`.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readExecutableHeader } from './executable-header';
import {
  ALL_BINARY_TARGETS,
  type BinaryTarget,
  type ReleasePlatformId,
  runtimeBinaryName,
} from './release-targets';
import { runtimeHeaderProblems, rustTargetTriple } from './runtime-build';
import {
  isRuntimeInputPath,
  type RuntimeBuildFacts,
  runtimeInputDigest,
  type RuntimeInputFile,
  unstampedArtifactName,
} from './runtime-input-digest';
import { readReleaseStamp } from './runtime-stamp';
import {
  describeReceived,
  invalidValue,
  requireJsonRecord,
  requirePositiveSafeInteger,
  sha256OfBytes,
} from './script-guards';

/** The GitHub read port; `createCanaryGhApi()` and the test fake both satisfy it. */
export interface RuntimeBaseApi {
  get(path: string): unknown;
  list(path: string, key: string): readonly unknown[];
}

/** Workflow file whose main push runs are the only accepted producers. */
const RUNTIME_BASE_WORKFLOW_FILE = 'ci.yml';
const RUNTIME_BASE_WORKFLOW_PATH = `.github/workflows/${RUNTIME_BASE_WORKFLOW_FILE}`;

/**
 * Name of the build job in a CI run, as the jobs API reports it: the caller's
 * name, the reusable workflow's, then the matrix leg's. Canary reads the same
 * names, so a rename fails both loudly instead of matching nothing.
 *
 * @example
 * runtimeBuildJobName('linux-x64'); // → 'Distribution / Runtime / Runtime linux-x64'
 */
export function runtimeBuildJobName(platform: string): string {
  return `Distribution / Runtime / Runtime ${platform}`;
}

/** What one search may spend: the newest runs read, candidates verified, and wall time. */
interface RuntimeBaseSearchBounds {
  /** Newest main push runs read from the listing (one page). */
  readonly maxRuns: number;
  /** Nominated runs verified in full, newest first. */
  readonly maxCandidates: number;
  /** Wall time after which no further candidate is started. */
  readonly budgetMs: number;
}

const RUNTIME_BASE_SEARCH_BOUNDS: RuntimeBaseSearchBounds = {
  maxRuns: 100,
  maxCandidates: 5,
  budgetMs: 60_000,
};

/** Injected so a test never reads the clock. */
export interface RuntimeBaseDeps {
  readonly now: () => number;
  readonly bounds: RuntimeBaseSearchBounds;
}

const DEFAULT_DEPS: RuntimeBaseDeps = { now: () => Date.now(), bounds: RUNTIME_BASE_SEARCH_BOUNDS };

/** The compare API lists at most 300 files; a response that reaches it may be cut. */
const COMPARE_FILE_LIMIT = 300;
/** Clock skew tolerated between a job's recorded window and its artifact's creation time. */
const ARTIFACT_CLOCK_SKEW_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARCHIVE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** What this checkout asks for. */
export interface RuntimeBaseRequest {
  readonly repository: string;
  readonly platform: string;
  readonly profile: string;
  /** The digest computed for THIS checkout. */
  readonly digest: string;
  /** The commit this job builds. */
  readonly sourceSha: string;
  /** This run: never its own producer, so a re-run cannot nominate itself. */
  readonly currentRunId: number;
  readonly eventName: string;
  readonly ref: string;
}

/** A producing job of a run, verified through the Actions API. */
export interface ProducerRun {
  readonly runId: number;
  readonly runAttempt: number;
  readonly sha: string;
  readonly jobId: number;
  readonly jobStartedAtMs: number;
  readonly jobCompletedAtMs: number;
}

/** The one artifact of a producer run that holds the base. */
export interface ProducerArtifact {
  readonly id: number;
  readonly name: string;
  /** `sha256:<hex>` of the archive, as the API recorded it at upload. */
  readonly archiveDigest: string;
}

export type RuntimeBaseVerdict =
  | {
      readonly reuse: true;
      readonly producer: ProducerRun;
      readonly artifact: ProducerArtifact;
    }
  | { readonly reuse: false; readonly reason: string };

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw invalidValue(label, 'non-empty string', value);
  }
  return value;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw invalidValue(label, '40-character lowercase hex commit SHA', value);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidValue(label, 'array', value);
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  const text = requireString(value, label);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw invalidValue(label, 'an ISO timestamp', text);
  return parsed;
}

function platformTarget(platform: string): BinaryTarget {
  const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === platform);
  if (!target) {
    throw invalidValue(
      'platform',
      `one of ${ALL_BINARY_TARGETS.map((candidate) => candidate.arch).join(', ')}`,
      platform
    );
  }
  return target;
}

/**
 * Why this context may never reuse, or null when it may. The workflow gates the
 * same conditions; this repeats them where a test can pin them, so a release,
 * a pull request, a dispatch or a light build can never reach the Actions API.
 *
 * @example
 * runtimeBaseContextProblem({ ...request, eventName: 'pull_request' }); // → 'expected event push | received: pull_request'
 */
export function runtimeBaseContextProblem(request: RuntimeBaseRequest): string | null {
  if (request.eventName !== 'push') {
    return `expected event push | received: ${request.eventName || '(empty)'}`;
  }
  if (request.ref !== 'refs/heads/main') {
    return `expected ref refs/heads/main | received: ${request.ref || '(empty)'}`;
  }
  if (request.profile !== 'shipping') {
    return `expected profile shipping | received: ${request.profile || '(empty)'}`;
  }
  if (!ALL_BINARY_TARGETS.some((target) => target.arch === request.platform)) {
    return `expected a release platform id | received: ${request.platform || '(empty)'}`;
  }
  if (!SHA256_PATTERN.test(request.digest)) {
    return `expected a 64-character hex digest | received: ${JSON.stringify(request.digest)}`;
  }
  if (!SHA_PATTERN.test(request.sourceSha)) {
    return `expected a 40-character source SHA | received: ${JSON.stringify(request.sourceSha)}`;
  }
  if (!REPOSITORY_PATTERN.test(request.repository)) {
    return `expected repository owner/name | received: ${JSON.stringify(request.repository)}`;
  }
  if (!Number.isSafeInteger(request.currentRunId) || request.currentRunId < 1) {
    return `expected a positive current run id | received: ${request.currentRunId}`;
  }
  return null;
}

/**
 * Verify run `runId` as the producer of `platform`'s runtime for a build at
 * `sourceSha`. Throws, naming the value and the expected shape, on any doubt.
 *
 * The run and its jobs are read from attempt 1 (`attempts/1`, `attempts/1/jobs`),
 * never from `actions/runs/{id}`: that endpoint reports the LATEST attempt, so a
 * maintainer re-running any job of the producer after others reused its base
 * would turn every later verification into a refusal. Attempt 1 is frozen.
 *
 * @example
 * verifyProducerRun(api, { repository, platform: 'linux-x64', sourceSha, excludeRunId: 7 }, 46128211509);
 */
export function verifyProducerRun(
  api: RuntimeBaseApi,
  scope: {
    readonly repository: string;
    readonly platform: string;
    readonly sourceSha: string;
    readonly excludeRunId: number;
  },
  producerRunId: number
): ProducerRun {
  const runId = requirePositiveSafeInteger(producerRunId, 'producer run id');
  const label = `producer run ${runId}`;
  if (runId === scope.excludeRunId) {
    throw invalidValue(`${label} id`, `a run other than ${scope.excludeRunId}`, runId);
  }
  const run = requireJsonRecord(
    api.get(`repos/${scope.repository}/actions/runs/${runId}/attempts/1`),
    `${label} attempt 1`
  );
  if (run.id !== runId) throw invalidValue(`${label} attempt 1 id`, String(runId), run.id);
  // Never an event that can carry another actor's workflow or inputs: only a
  // push to this repository's main branch, in the CI workflow file.
  for (const [field, expected] of [
    ['event', 'push'],
    ['head_branch', 'main'],
    ['path', RUNTIME_BASE_WORKFLOW_PATH],
  ] as const) {
    if (run[field] !== expected) throw invalidValue(`${label} ${field}`, expected, run[field]);
  }
  for (const field of ['repository', 'head_repository'] as const) {
    const name = requireJsonRecord(run[field], `${label} ${field}`).full_name;
    if (name !== scope.repository) {
      throw invalidValue(`${label} ${field}`, scope.repository, name);
    }
  }
  // Attempt 1 only: a re-run can leave artifacts of different attempts under one
  // run id. Binding to attempt 1 keeps the job and the artifact (checked against
  // this job's time window) one attempt's, whatever re-runs happen later.
  if (run.run_attempt !== 1) {
    throw invalidValue(`${label} run_attempt`, '1 (the attempt read)', run.run_attempt);
  }
  const sha = requireSha(run.head_sha, `${label} head_sha`);

  const jobName = runtimeBuildJobName(scope.platform);
  const jobs = api
    .list(`repos/${scope.repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100`, 'jobs')
    .map((job, index) => requireJsonRecord(job, `${label} job ${index}`))
    .filter((job) => job.name === jobName);
  const [job] = jobs;
  if (jobs.length !== 1 || !job) {
    throw invalidValue(`${label} jobs named "${jobName}"`, 'exactly one', jobs.length);
  }
  if (job.status !== 'completed' || job.conclusion !== 'success' || job.run_id !== runId) {
    throw invalidValue(
      `${label} job "${jobName}" status, conclusion and run_id`,
      `completed, success and ${runId}`,
      { status: job.status, conclusion: job.conclusion, run_id: job.run_id }
    );
  }
  const jobAttempt = requirePositiveSafeInteger(job.run_attempt, `${label} job run_attempt`);
  if (jobAttempt !== 1) {
    throw invalidValue(`${label} job run_attempt`, '1', jobAttempt);
  }

  assertAncestorWithoutInputChanges(api, scope.repository, sha, scope.sourceSha);
  return {
    runId,
    runAttempt: 1,
    sha,
    jobId: requirePositiveSafeInteger(job.id, `${label} job id`),
    jobStartedAtMs: requireTimestamp(job.started_at, `${label} job started_at`),
    jobCompletedAtMs: requireTimestamp(job.completed_at, `${label} job completed_at`),
  };
}

/**
 * `ancestor` must be an ancestor of (or equal to) `descendant`, and no runtime
 * input path may differ between them. The digest already implies the second; the
 * compare API is a source that shares none of its code.
 */
function assertAncestorWithoutInputChanges(
  api: RuntimeBaseApi,
  repository: string,
  ancestor: string,
  descendant: string
): void {
  const compare = requireJsonRecord(
    api.get(`repos/${repository}/compare/${ancestor}...${descendant}`),
    `compare ${ancestor}...${descendant}`
  );
  const label = `compare ${ancestor.slice(0, 12)}...${descendant.slice(0, 12)}`;
  if (!['ahead', 'identical'].includes(String(compare.status))) {
    throw invalidValue(
      `${label} status`,
      'ahead or identical (the producer commit is an ancestor)',
      compare.status
    );
  }
  for (const field of ['base_commit', 'merge_base_commit'] as const) {
    const sha = requireJsonRecord(compare[field], `${label} ${field}`).sha;
    if (sha !== ancestor) throw invalidValue(`${label} ${field} sha`, ancestor, sha);
  }
  if (compare.truncated !== undefined && compare.truncated !== false) {
    throw invalidValue(`${label} truncated`, 'false', compare.truncated);
  }
  const files = requireArray(compare.files, `${label} files`);
  if (files.length >= COMPARE_FILE_LIMIT) {
    throw invalidValue(
      `${label} files`,
      `fewer than ${COMPARE_FILE_LIMIT} entries (the API truncates there)`,
      `${files.length} entries`
    );
  }
  for (const [index, file] of files.entries()) {
    const record = requireJsonRecord(file, `${label} file ${index}`);
    const paths = [requireString(record.filename, `${label} file ${index} filename`)];
    if (record.previous_filename !== undefined) {
      paths.push(
        requireString(record.previous_filename, `${label} file ${index} previous_filename`)
      );
    }
    const changed = paths.find((path) => isRuntimeInputPath(path));
    if (changed !== undefined) {
      throw invalidValue(`${label} changed path`, 'no runtime input path', changed);
    }
  }
}

/** The one unexpired artifact of the producer run named `name`, with its archive digest. */
function selectProducerArtifact(
  api: RuntimeBaseApi,
  repository: string,
  producer: ProducerRun,
  name: string,
  now: number
): ProducerArtifact {
  const body = requireJsonRecord(
    api.get(
      `repos/${repository}/actions/runs/${producer.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`
    ),
    `run ${producer.runId} artifacts`
  );
  const matches = requireArray(body.artifacts, `run ${producer.runId} artifacts.artifacts`)
    .map((artifact, index) =>
      requireJsonRecord(artifact, `run ${producer.runId} artifact ${index}`)
    )
    .filter((artifact) => artifact.name === name);
  const [artifact] = matches;
  if (matches.length !== 1 || !artifact) {
    throw invalidValue(
      `run ${producer.runId} artifacts named ${name}`,
      'exactly one',
      matches.length
    );
  }
  const label = `run ${producer.runId} artifact ${name}`;
  if (artifact.expired !== false) throw invalidValue(`${label} expired`, 'false', artifact.expired);
  const expiresAt = requireTimestamp(artifact.expires_at, `${label} expires_at`);
  if (expiresAt <= now) {
    throw invalidValue(`${label} expires_at`, 'a time in the future', artifact.expires_at);
  }
  const origin = requireJsonRecord(artifact.workflow_run, `${label} workflow_run`);
  for (const [field, expected] of [
    ['id', producer.runId],
    ['head_branch', 'main'],
    ['head_sha', producer.sha],
  ] as const) {
    if (origin[field] !== expected) {
      throw invalidValue(`${label} workflow_run.${field}`, String(expected), origin[field]);
    }
  }
  // Same repository on both sides: a fork's run would name another head repository.
  if (
    typeof origin.repository_id !== 'number' ||
    origin.head_repository_id !== origin.repository_id
  ) {
    throw invalidValue(
      `${label} workflow_run head_repository_id`,
      `repository_id ${String(origin.repository_id)}`,
      origin.head_repository_id
    );
  }
  // The receipt carries no job id, so the artifact is bound to the job by time:
  // it was created while that job ran.
  const createdAt = requireTimestamp(artifact.created_at, `${label} created_at`);
  if (
    createdAt < producer.jobStartedAtMs - ARTIFACT_CLOCK_SKEW_MS ||
    createdAt > producer.jobCompletedAtMs + ARTIFACT_CLOCK_SKEW_MS
  ) {
    throw invalidValue(
      `${label} created_at ${String(artifact.created_at)}`,
      `inside job ${producer.jobId}'s window`,
      `${new Date(producer.jobStartedAtMs).toISOString()}..${new Date(producer.jobCompletedAtMs).toISOString()}`
    );
  }
  const archiveDigest = artifact.digest;
  if (typeof archiveDigest !== 'string' || !ARCHIVE_DIGEST_PATTERN.test(archiveDigest)) {
    throw invalidValue(`${label} digest`, 'sha256:<64 lowercase hex>', archiveDigest);
  }
  return {
    id: requirePositiveSafeInteger(artifact.id, `${label} id`),
    name,
    archiveDigest,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : describeReceived(error);
}

/**
 * Verify one run record as the producer for `request` and select its artifact.
 * The resolver calls it for each listed candidate; the CLI's `verify` command
 * calls it again for the run it downloaded from, so the receipt is checked
 * against what the API says now. Throws on any doubt.
 *
 * @example
 * const { producer, artifact } = verifyRuntimeBaseCandidate(api, request, runRecord, Date.now());
 */
export function verifyRuntimeBaseCandidate(
  api: RuntimeBaseApi,
  request: RuntimeBaseRequest,
  runId: number,
  now: number
): { readonly producer: ProducerRun; readonly artifact: ProducerArtifact } {
  const producer = verifyProducerRun(
    api,
    {
      repository: request.repository,
      platform: request.platform,
      sourceSha: request.sourceSha,
      excludeRunId: request.currentRunId,
    },
    runId
  );
  const name = unstampedArtifactName(request.platform, request.digest);
  return {
    producer,
    artifact: selectProducerArtifact(api, request.repository, producer, name, now),
  };
}

/**
 * Find a verified base for `request`, or say why not. Never throws; every failed
 * read, malformed payload or doubt is `reuse: false` with the reason.
 *
 * @example
 * resolveRuntimeBase(createCanaryGhApi(), { repository, platform: 'linux-x64', profile: 'shipping', digest, sourceSha, currentRunId, eventName: 'push', ref: 'refs/heads/main' });
 */
export function resolveRuntimeBase(
  api: RuntimeBaseApi,
  request: RuntimeBaseRequest,
  deps: RuntimeBaseDeps = DEFAULT_DEPS
): RuntimeBaseVerdict {
  const started = deps.now();
  let stage = 'context';
  try {
    const contextProblem = runtimeBaseContextProblem(request);
    if (contextProblem) return { reuse: false, reason: `${stage}: ${contextProblem}` };
    const name = unstampedArtifactName(request.platform, request.digest);
    const { repository } = request;

    stage = 'main push run listing';
    const listing = requireJsonRecord(
      api.get(
        `repos/${repository}/actions/workflows/${RUNTIME_BASE_WORKFLOW_FILE}/runs?event=push&branch=main&per_page=${deps.bounds.maxRuns}`
      ),
      'workflow run listing'
    );
    const runs = requireArray(listing.workflow_runs, 'workflow run listing workflow_runs')
      .map((run, index) => requireJsonRecord(run, `listed run ${index}`))
      // The query filters already; repeating them keeps an ignored parameter from choosing a run.
      .filter((run) => run.event === 'push' && run.head_branch === 'main')
      .sort(
        (left, right) =>
          requirePositiveSafeInteger(right.run_number, 'run number') -
          requirePositiveSafeInteger(left.run_number, 'run number')
      )
      .slice(0, deps.bounds.maxRuns);

    // Nomination only: a flood of same-named artifacts can push the real one off
    // this page and cause a refusal, never an acceptance.
    stage = 'artifact nomination';
    const nominated = new Set(
      requireArray(
        requireJsonRecord(
          api.get(
            `repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`
          ),
          'artifact listing'
        ).artifacts,
        'artifact listing artifacts'
      )
        .map((artifact, index) => requireJsonRecord(artifact, `listed artifact ${index}`))
        .filter((artifact) => artifact.name === name && artifact.expired === false)
        .map((artifact) => requireJsonRecord(artifact.workflow_run, 'artifact workflow_run').id)
    );
    const candidates = runs
      .filter((run) => nominated.has(run.id))
      .slice(0, deps.bounds.maxCandidates);
    if (candidates.length === 0) {
      return {
        reuse: false,
        reason: `no run among the newest ${runs.length} main push runs of ${RUNTIME_BASE_WORKFLOW_FILE} has an unexpired artifact ${name}`,
      };
    }

    const rejected: string[] = [];
    for (const candidate of candidates) {
      if (deps.now() - started > deps.bounds.budgetMs) {
        rejected.push(`time budget of ${deps.bounds.budgetMs} ms spent`);
        break;
      }
      stage = `candidate run ${String(candidate.id)}`;
      try {
        // The listing shows the run's latest attempt; verification re-reads attempt 1.
        const candidateId = requirePositiveSafeInteger(candidate.id, `${stage} id`);
        return {
          reuse: true,
          ...verifyRuntimeBaseCandidate(api, request, candidateId, deps.now()),
        };
      } catch (error) {
        rejected.push(`${stage}: ${describeError(error)}`);
      }
    }
    return { reuse: false, reason: rejected.join(' | ') };
  } catch (error) {
    return { reuse: false, reason: `${stage}: ${describeError(error)}` };
  }
}

/** What a downloaded base must match. */
export interface RuntimeBaseExpectation {
  readonly platform: string;
  readonly profile: string;
  readonly digest: string;
  /** Whether Linux gnu targets link through zig, which pins the glibc floor. */
  readonly zig: boolean;
  /** The run the listing verified, as the receipt must name it. */
  readonly producer: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly sha: string;
    readonly repository: string;
  };
}

export interface VerifiedRuntimeBase {
  readonly binaryPath: string;
  readonly binaryName: string;
  readonly sha256: string;
  readonly bytes: number;
}

const RECEIPT_KEYS = [
  'schema',
  'digest',
  'target',
  'profile',
  'rustc',
  'manifest',
  'binary',
  'producer',
] as const;
const PRODUCER_KEYS = ['runId', 'runAttempt', 'sha', 'sourceSha', 'repository', 'runner'] as const;

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const received = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (received.join('\0') !== expected.join('\0')) {
    throw invalidValue(`${label} keys`, expected.join(', '), received.join(', '));
  }
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireJsonRecord(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw invalidValue(`${label}.${key}`, 'string', entry);
  }
  return record as Record<string, string>;
}

function requireReceiptFacts(value: unknown, expected: RuntimeBaseExpectation): RuntimeBuildFacts {
  const facts = requireJsonRecord(value, 'receipt manifest facts');
  requireExactKeys(
    facts,
    ['platform', 'triple', 'profile', 'cargoProfile', 'command', 'env', 'tools'],
    'receipt manifest facts'
  );
  const platform = platformTarget(expected.platform).arch;
  for (const [field, want] of [
    ['platform', platform],
    ['triple', rustTargetTriple(platform)],
    ['profile', expected.profile],
    ['cargoProfile', 'release'],
  ] as const) {
    if (facts[field] !== want) {
      throw invalidValue(`receipt manifest facts.${field}`, want, facts[field]);
    }
  }
  const command = requireArray(facts.command, 'receipt manifest facts.command');
  if (!command.every((part) => typeof part === 'string')) {
    throw invalidValue('receipt manifest facts.command', 'array of strings', command);
  }
  return {
    platform,
    triple: facts.triple as string,
    profile: expected.profile,
    cargoProfile: 'release',
    command: command as string[],
    env: requireStringRecord(facts.env, 'receipt manifest facts.env'),
    tools: requireStringRecord(facts.tools, 'receipt manifest facts.tools'),
  };
}

/**
 * Check a downloaded base against what was asked for and what the run listing
 * verified. Throws, naming the value and the expected shape, on any mismatch.
 * Run after the ZIP's own digest was checked by the download.
 *
 * @example
 * verifyRuntimeBaseFiles(dir, { platform: 'linux-x64', profile: 'shipping', digest, zig: true, producer });
 */
export function verifyRuntimeBaseFiles(
  directory: string,
  expected: RuntimeBaseExpectation
): VerifiedRuntimeBase {
  const target = platformTarget(expected.platform);
  const binaryName = runtimeBinaryName(target.name);

  // Exactly the two files the stage-2 upload wrote, as regular files: a symlink
  // or a stray entry means this is not that artifact.
  const entries = readdirSync(directory).sort();
  if (entries.join('\0') !== [binaryName, 'receipt.json'].sort().join('\0')) {
    throw invalidValue('base directory entries', `${binaryName}, receipt.json`, entries);
  }
  for (const entry of entries) {
    if (!lstatSync(join(directory, entry)).isFile()) {
      throw invalidValue(`base entry ${entry}`, 'a regular file', 'not a regular file');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  } catch (error) {
    throw invalidValue('receipt.json', 'a JSON object', describeError(error));
  }
  const receipt = requireJsonRecord(parsed, 'receipt.json');
  requireExactKeys(receipt, RECEIPT_KEYS, 'receipt');
  if (receipt.schema !== 'mangostudio-runtime-input-receipt/v1') {
    throw invalidValue('receipt schema', 'mangostudio-runtime-input-receipt/v1', receipt.schema);
  }
  if (receipt.digest !== expected.digest) {
    throw invalidValue('receipt digest', expected.digest, receipt.digest);
  }
  if (receipt.profile !== expected.profile) {
    throw invalidValue('receipt profile', expected.profile, receipt.profile);
  }
  const triple = rustTargetTriple(target.arch);
  const receiptTarget = requireJsonRecord(receipt.target, 'receipt target');
  requireExactKeys(receiptTarget, ['platform', 'triple'], 'receipt target');
  if (receiptTarget.platform !== target.arch || receiptTarget.triple !== triple) {
    throw invalidValue(
      'receipt target',
      `${target.arch} ${triple}`,
      `${String(receiptTarget.platform)} ${String(receiptTarget.triple)}`
    );
  }

  // The receipt must derive its own digest: a digest copied beside another
  // build's manifest would describe inputs the binary was not built from.
  const manifest = requireJsonRecord(receipt.manifest, 'receipt manifest');
  requireExactKeys(manifest, ['schema', 'files', 'facts'], 'receipt manifest');
  const files = requireArray(manifest.files, 'receipt manifest files').map((file, index) => {
    const record = requireJsonRecord(file, `receipt manifest file ${index}`);
    requireExactKeys(record, ['path', 'blob'], `receipt manifest file ${index}`);
    return {
      path: requireString(record.path, `receipt manifest file ${index} path`),
      blob: requireString(record.blob, `receipt manifest file ${index} blob`),
    } satisfies RuntimeInputFile;
  });
  const recomputed = runtimeInputDigest(files, requireReceiptFacts(manifest.facts, expected));
  if (recomputed !== expected.digest) {
    throw invalidValue('digest of the receipt manifest', expected.digest, recomputed);
  }

  const producer = requireJsonRecord(receipt.producer, 'receipt producer');
  requireExactKeys(producer, PRODUCER_KEYS, 'receipt producer');
  for (const [field, want] of [
    ['runId', String(expected.producer.runId)],
    ['runAttempt', String(expected.producer.runAttempt)],
    ['sha', expected.producer.sha],
    ['sourceSha', expected.producer.sha],
    ['repository', expected.producer.repository],
  ] as const) {
    if (producer[field] !== want) {
      throw invalidValue(`receipt producer.${field}`, want, producer[field]);
    }
  }

  const binary = requireJsonRecord(receipt.binary, 'receipt binary');
  requireExactKeys(binary, ['name', 'sha256', 'bytes'], 'receipt binary');
  if (binary.name !== binaryName)
    throw invalidValue('receipt binary name', binaryName, binary.name);
  if (typeof binary.sha256 !== 'string' || !SHA256_PATTERN.test(binary.sha256)) {
    throw invalidValue('receipt binary sha256', '64 lowercase hex characters', binary.sha256);
  }

  const binaryPath = join(directory, binaryName);
  const bytes = readFileSync(binaryPath);
  const actual = sha256OfBytes(bytes);
  if (bytes.length === 0 || binary.bytes !== bytes.length || binary.sha256 !== actual) {
    throw invalidValue(
      'binary bytes and SHA-256',
      `${String(binary.bytes)} bytes, ${String(binary.sha256)}`,
      `${bytes.length} bytes, ${actual}`
    );
  }
  const problems = runtimeHeaderProblems(target.arch, readExecutableHeader(bytes), {
    enforceGlibcFloor: expected.zig,
  });
  if (problems.length > 0) {
    throw invalidValue('binary executable header', `a ${target.arch} runtime`, problems.join('; '));
  }
  // The base must be the bytes every version derives from: a stamped one would
  // be stamped again silently when the version matches.
  const stamp = readReleaseStamp(bytes);
  if (stamp.version !== null) {
    throw invalidValue('binary release stamp', 'unstamped', stamp.version);
  }
  return { binaryPath, binaryName, sha256: actual, bytes: bytes.length };
}

const RUNTIME_REUSE_RECORD_SCHEMA = 'mangostudio-runtime-reuse-record/v1';

/**
 * Provenance of one reused base: the ORIGINAL producer, and the reusing run
 * apart from it. Uploaded by the reusing job; Canary reads its name, and a human
 * reads its content.
 */
export interface RuntimeReuseRecord {
  readonly schema: typeof RUNTIME_REUSE_RECORD_SCHEMA;
  readonly platform: string;
  readonly profile: string;
  readonly digest: string;
  readonly binary: { readonly name: string; readonly sha256: string; readonly bytes: number };
  readonly producer: {
    readonly repository: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly sha: string;
    readonly jobId: number;
    readonly artifactId: number;
    readonly artifactName: string;
    readonly archiveDigest: string;
  };
  readonly reusedBy: {
    readonly repository: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly sha: string;
  };
}

/** What a reuse record's artifact name says about the reuse. */
interface RuntimeReuseNameFields {
  readonly platform: ReleasePlatformId;
  readonly producerRunId: number;
  /** Input digest the producer and the reusing run share. */
  readonly digest: string;
  /** SHA-256 of the unstamped binary the reusing job verified. */
  readonly binarySha256: string;
}

/**
 * Artifact name of a reuse record. It carries the platform, the producing run,
 * the input digest and the binary's SHA-256, so Canary can show and verify the
 * claim from the artifact listing alone (it holds `actions: read` and cannot read
 * the record's content or annotations).
 *
 * @example
 * runtimeReuseArtifactName('linux-x64', 46128211509, digest, binarySha256);
 * // → 'runtime-reuse-linux-x64-46128211509-<digest>-<binary sha256>'
 */
export function runtimeReuseArtifactName(
  platform: string,
  producerRunId: number,
  digest: string,
  binarySha256: string
): string {
  platformTarget(platform);
  requirePositiveSafeInteger(producerRunId, 'producer run id');
  for (const [label, value] of [
    ['digest', digest],
    ['binary sha256', binarySha256],
  ] as const) {
    if (!SHA256_PATTERN.test(value)) {
      throw invalidValue(label, '64 lowercase hex characters', value);
    }
  }
  return `runtime-reuse-${platform}-${producerRunId}-${digest}-${binarySha256}`;
}

/**
 * Inverse of {@link runtimeReuseArtifactName}; null for any other name.
 *
 * @example
 * parseRuntimeReuseArtifactName(`runtime-reuse-linux-x64-7-${digest}-${binarySha256}`);
 * // → { platform: 'linux-x64', producerRunId: 7, digest, binarySha256 }
 */
export function parseRuntimeReuseArtifactName(name: string): RuntimeReuseNameFields | null {
  // Longest platform id first: `linux-x64` is a prefix of `linux-x64-musl`.
  const platforms = ALL_BINARY_TARGETS.map((target) => target.arch).sort(
    (left, right) => right.length - left.length
  );
  for (const platform of platforms) {
    const prefix = `runtime-reuse-${platform}-`;
    if (!name.startsWith(prefix)) continue;
    const rest = /^([1-9]\d{0,15})-([0-9a-f]{64})-([0-9a-f]{64})$/.exec(name.slice(prefix.length));
    if (rest?.[1] && rest[2] && rest[3] && Number.isSafeInteger(Number(rest[1]))) {
      return { platform, producerRunId: Number(rest[1]), digest: rest[2], binarySha256: rest[3] };
    }
  }
  return null;
}

/**
 * Assemble a reuse record from what the listing verified and the bytes the job
 * verified after download.
 *
 * @example
 * buildRuntimeReuseRecord({ request, verdict, base, reusedBy });
 */
export function buildRuntimeReuseRecord(source: {
  readonly request: RuntimeBaseRequest;
  readonly producer: ProducerRun;
  readonly artifact: ProducerArtifact;
  readonly base: VerifiedRuntimeBase;
  readonly reusedBy: RuntimeReuseRecord['reusedBy'];
}): RuntimeReuseRecord {
  const { request, producer, artifact, base } = source;
  return {
    schema: RUNTIME_REUSE_RECORD_SCHEMA,
    platform: request.platform,
    profile: request.profile,
    digest: request.digest,
    binary: { name: base.binaryName, sha256: base.sha256, bytes: base.bytes },
    producer: {
      repository: request.repository,
      runId: producer.runId,
      runAttempt: producer.runAttempt,
      sha: producer.sha,
      jobId: producer.jobId,
      artifactId: artifact.id,
      artifactName: artifact.name,
      archiveDigest: artifact.archiveDigest,
    },
    reusedBy: source.reusedBy,
  };
}

/**
 * Step-summary markdown for a reused base: which run built it, which run reuses
 * it, and the hashes a maintainer can compare with the producer's own summary.
 *
 * @example
 * renderRuntimeReuseSummary(record); // → '### Runtime base linux-x64: reused\n\n…'
 */
export function renderRuntimeReuseSummary(record: RuntimeReuseRecord, serverUrl: string): string {
  const link = (runId: number): string =>
    `[${runId}](${serverUrl}/${record.producer.repository}/actions/runs/${runId})`;
  return [
    `### Runtime base ${record.platform}: reused (cargo skipped)`,
    '',
    '| Input digest | Unstamped binary SHA-256 | Bytes | Built by run | Reused by run |',
    '| --- | --- | ---: | --- | --- |',
    `| \`${record.digest}\` | \`${record.binary.sha256}\` | ${record.binary.bytes} | ${link(record.producer.runId)} (commit \`${record.producer.sha}\`) | ${link(record.reusedBy.runId)} |`,
    '',
  ].join('\n');
}

/**
 * Step-summary markdown for a search that found nothing: the job built from source.
 *
 * @example
 * renderRuntimeBaseRefusalSummary('linux-x64', 'no run among the newest 100…');
 */
export function renderRuntimeBaseRefusalSummary(platform: string, reason: string): string {
  return [
    `### Runtime base ${platform}: built from source`,
    '',
    `Reuse was on but no verified base was found. Reason: ${reason.replaceAll('\n', ' ')}`,
    '',
  ].join('\n');
}
