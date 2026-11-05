import { createHash } from 'node:crypto';

import type { CanaryApprovalApi } from './canary-approval';
import { type CanarySource, selectCanarySource } from './canary-source';
import { isValidSemver, normalizeVersion } from './release-version';

/** One canary execution remains tied to this selection across full workflow reruns. */
interface CanarySourceSnapshot {
  readonly schemaVersion: 1;
  readonly source: CanarySource;
  readonly version: string;
  readonly channel: 'canary';
  readonly executionRevision: string;
}
/** Current execution identity, separate from its selected application commit. */
export interface CanarySourceExecution {
  readonly repository: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly executionRevision: string;
}
/** Resolved selection is persisted before checking out the selected application. */
export interface CanarySourceResolution {
  readonly source: CanarySource;
  readonly executionRevision: string;
  readonly restored: boolean;
  readonly originalAttempt?: number;
  readonly snapshotRaw?: string;
}
/** Transport keeps real status, complete pages, and every ZIP member; duplicate ZIP names must reject. */
export interface CanarySourceSnapshotDependencies {
  readonly github: Pick<CanaryApprovalApi, 'getJson' | 'list' | 'readBytes'>;
  unzip(bytes: Uint8Array): Promise<ReadonlyMap<string, Uint8Array>>;
}
const SOURCE_JOB = 'Resolve latest green main commit';
const LIMIT = 1024 * 1024;

/**
 * Restore the earliest successful source job in the same canary run, or select
 * latest eligible CI only when no earlier source job succeeded. A missing or
 * expired snapshot blocks the rerun instead of silently selecting a new source.
 * Example: await resolveCanarySourceSnapshot(execution, dependencies).
 */
export async function resolveCanarySourceSnapshot(
  execution: CanarySourceExecution,
  deps: CanarySourceSnapshotDependencies
): Promise<CanarySourceResolution> {
  validateExecution(execution);
  const base = `repos/${execution.repository}`;
  const repository = record(await get(deps, base), 'repository');
  const repositoryId = positive(repository.id, 'repository ID');
  if (repository.full_name !== execution.repository)
    throw new Error('Invalid source-snapshot repository: expected current repository identity');
  const canaryWorkflow = await workflow(deps, base, 'canary.yml');
  const current = validateCanaryRun(
    await get(deps, `${base}/actions/runs/${execution.runId}/attempts/${execution.runAttempt}`),
    execution,
    repositoryId,
    canaryWorkflow,
    execution.runAttempt
  );
  const allJobs = (
    await deps.github.list(
      `${base}/actions/runs/${execution.runId}/jobs?filter=all&per_page=100`,
      'jobs'
    )
  )
    .map((job) => record(job, 'source job'))
    .filter((job) => job.name === SOURCE_JOB);
  const attempts = new Set<number>();
  for (const job of allJobs) {
    const attempt = positive(job.run_attempt, 'source producer attempt');
    positive(job.id, 'source job ID');
    if (
      job.run_id !== execution.runId ||
      job.head_sha !== execution.executionRevision ||
      attempts.has(attempt)
    )
      throw new Error(
        'Invalid source job: expected unique attempt and matching canary run/execution SHA'
      );
    attempts.add(attempt);
  }
  if (!attempts.has(execution.runAttempt))
    throw new Error(
      'Invalid current source job context: expected named source job for current attempt'
    );
  const earlier = allJobs
    .filter(
      (job) =>
        Number(job.run_attempt) < execution.runAttempt &&
        job.status === 'completed' &&
        job.conclusion === 'success'
    )
    .sort((left, right) => Number(left.run_attempt) - Number(right.run_attempt));
  const original = earlier[0];
  if (!original) {
    const ciWorkflow = await workflow(deps, base, 'ci.yml');
    const runs = await deps.github.list(
      `${base}/actions/workflows/${ciWorkflow}/runs?branch=main&event=push&status=success&per_page=100`,
      'workflow_runs'
    );
    const selected = selectCanarySource(runs, execution.repository, ciWorkflow);
    const raw = runs.find(
      (value) =>
        value !== null && typeof value === 'object' && 'id' in value && value.id === selected.runId
    );
    assertCiRepositories(raw, execution.repository, repositoryId);
    return { source: selected, executionRevision: execution.executionRevision, restored: false };
  }
  const attempt = positive(original.run_attempt, 'original source attempt');
  const historical = validateCanaryRun(
    await get(deps, `${base}/actions/runs/${execution.runId}/attempts/${attempt}`),
    execution,
    repositoryId,
    canaryWorkflow,
    attempt
  );
  if (historical.run_number !== current.run_number)
    throw new Error('Invalid source producer history: expected original canary run number');
  const started = timestamp(original.started_at, 'source job start');
  const completed = timestamp(original.completed_at, 'source job completion');
  if (completed < started)
    throw new Error('Invalid source job timestamps: expected ordered interval');
  const artifactName = `canary-source-${execution.runId}-${attempt}`;
  const artifacts = (
    await deps.github.list(
      `${base}/actions/runs/${execution.runId}/artifacts?per_page=100`,
      'artifacts'
    )
  ).map((value) => record(value, 'source artifact'));
  const matches = artifacts.filter((artifact) => artifact.name === artifactName);
  const artifact = matches[0];
  if (matches.length !== 1 || !artifact || artifact.expired === true)
    throw unavailable(attempt, 'original snapshot missing, ambiguous or expired');
  const association = record(artifact.workflow_run, 'source artifact workflow_run');
  positive(association.repository_id, 'snapshot repository ID');
  positive(association.head_repository_id, 'snapshot head repository ID');
  const created = timestamp(artifact.created_at, 'snapshot upload');
  if (
    association.id !== execution.runId ||
    association.repository_id !== repositoryId ||
    association.head_repository_id !== repositoryId ||
    association.head_sha !== execution.executionRevision ||
    association.head_branch !== 'main' ||
    artifact.expired !== false ||
    created < started ||
    created > completed
  )
    throw new Error(
      'Invalid source snapshot association: expected original successful main canary source job and upload interval'
    );
  const artifactId = positive(artifact.id, 'snapshot artifact ID');
  const size = positive(artifact.size_in_bytes, 'snapshot ZIP size');
  if (
    size > LIMIT ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
  )
    throw new Error(
      'Invalid source snapshot integrity: expected bounded ZIP and immutable SHA256 digest'
    );
  const response = await deps.github.readBytes(`${base}/actions/artifacts/${artifactId}/zip`);
  if (response.status === 404 || response.status === 410)
    throw unavailable(attempt, 'original snapshot deleted after listing');
  ok(response.status, 'source snapshot ZIP');
  if (response.body.byteLength !== size || `sha256:${hash(response.body)}` !== artifact.digest)
    throw new Error('Corrupt source snapshot ZIP: expected immutable size and SHA256 digest');
  const members = await deps.unzip(response.body);
  const bytes = members.get('source.json');
  if (members.size !== 1 || !bytes || bytes.byteLength > LIMIT)
    throw new Error('Invalid source snapshot ZIP: expected sole bounded flat source.json');
  const raw = Buffer.from(bytes).toString('utf8');
  const snapshot = parseSnapshot(raw, execution.repository, execution.executionRevision);
  const ci = await get(
    deps,
    `${base}/actions/runs/${snapshot.source.runId}/attempts/${snapshot.source.runAttempt}`
  );
  assertCiRepositories(ci, execution.repository, repositoryId);
  const verified = selectCanarySource([ci], execution.repository, snapshot.source.workflowId);
  if (!sameSource(snapshot.source, verified))
    throw new Error(
      'Invalid saved CI selection: expected exact successful historical run, attempt and metadata'
    );
  return {
    source: snapshot.source,
    executionRevision: execution.executionRevision,
    restored: true,
    originalAttempt: attempt,
    snapshotRaw: raw,
  };
}

/**
 * Finish source identity only after the selected application checkout resolves
 * its version/channel. Restored snapshots retain their original exact bytes.
 * Example: writeCanarySourceSnapshot(selection,{sourceSha,version,channel,executionRevision}).
 */
export function writeCanarySourceSnapshot(
  resolution: CanarySourceResolution,
  identity: {
    readonly sourceSha: string;
    readonly version: string;
    readonly channel: string;
    readonly executionRevision: string;
  }
): { readonly raw: string; readonly snapshot: CanarySourceSnapshot } {
  const selection = record(resolution, 'source resolution');
  const source = parseSource(selection.source);
  if (
    typeof selection.restored !== 'boolean' ||
    selection.executionRevision !== identity.executionRevision ||
    !/^[a-f0-9]{40}$/.test(identity.executionRevision) ||
    source.sourceSha !== identity.sourceSha
  )
    throw new Error(
      'Invalid source identity write: expected frozen source and original workflow execution revision'
    );
  validateVersion(identity.version, identity.channel, source.sourceSha);
  if (selection.restored) {
    if (typeof selection.snapshotRaw !== 'string')
      throw new Error('Invalid restored source resolution: expected original snapshot bytes');
    const snapshot = parseSnapshot(
      selection.snapshotRaw,
      source.repository,
      identity.executionRevision
    );
    if (
      !sameSource(snapshot.source, source) ||
      snapshot.version !== identity.version ||
      snapshot.channel !== identity.channel
    )
      throw new Error(
        `Restored source identity mismatch: expected ${snapshot.version}/${snapshot.channel} and exact frozen CI selection; received ${identity.version}/${identity.channel}`
      );
    return { raw: selection.snapshotRaw, snapshot };
  }
  if (selection.snapshotRaw !== undefined)
    throw new Error('Invalid new source resolution: unexpected restored snapshot bytes');
  const snapshot: CanarySourceSnapshot = {
    schemaVersion: 1,
    source,
    version: identity.version,
    channel: 'canary',
    executionRevision: identity.executionRevision,
  };
  return { raw: `${JSON.stringify(snapshot, null, 2)}\n`, snapshot };
}

function parseSnapshot(raw: string, repository: string, revision: string): CanarySourceSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Invalid source snapshot: expected schema1 JSON', { cause });
  }
  const snapshot = record(value, 'source snapshot');
  const source = parseSource(snapshot.source);
  if (
    snapshot.schemaVersion !== 1 ||
    source.repository !== repository ||
    snapshot.executionRevision !== revision ||
    typeof snapshot.version !== 'string' ||
    snapshot.channel !== 'canary'
  )
    throw new Error(
      'Invalid source snapshot: expected schema1, selected repository and original execution revision'
    );
  validateVersion(snapshot.version, snapshot.channel, source.sourceSha);
  return {
    schemaVersion: 1,
    source,
    version: snapshot.version,
    channel: 'canary',
    executionRevision: revision,
  };
}
function parseSource(raw: unknown): CanarySource {
  const source = record(raw, 'frozen CI source');
  for (const key of ['runId', 'runAttempt', 'runNumber', 'workflowId'])
    positive(source[key], `CI ${key}`);
  if (
    typeof source.repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository) ||
    typeof source.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(source.sourceSha) ||
    source.workflowPath !== '.github/workflows/ci.yml' ||
    source.runUrl !== `https://github.com/${source.repository}/actions/runs/${source.runId}`
  )
    throw new Error(
      'Invalid frozen CI source: expected owner/repository, full source SHA, CI workflow and canonical run URL'
    );
  return {
    runId: Number(source.runId),
    runAttempt: Number(source.runAttempt),
    runNumber: Number(source.runNumber),
    sourceSha: source.sourceSha,
    repository: source.repository,
    workflowId: Number(source.workflowId),
    workflowPath: '.github/workflows/ci.yml',
    runUrl: String(source.runUrl),
  };
}
function validateVersion(version: string, channel: string, sha: string): void {
  const short = sha.slice(0, 7);
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    !isValidSemver(version) ||
    normalizeVersion(version) !== version ||
    !version.endsWith(`-canary.${identifier}`) ||
    channel !== 'canary'
  )
    throw new Error(
      `Invalid selected application identity: expected canonical canary version for ${sha} and channel canary; received ${version}/${channel}`
    );
}
function validateExecution(execution: CanarySourceExecution): void {
  positive(execution.runId, 'canary run ID');
  positive(execution.runAttempt, 'canary run attempt');
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(execution.repository) ||
    !/^[a-f0-9]{40}$/.test(execution.executionRevision)
  )
    throw new Error(
      'Invalid canary execution: expected owner/repository and full workflow execution SHA'
    );
}
function validateCanaryRun(
  raw: unknown,
  execution: CanarySourceExecution,
  repositoryId: number,
  workflowId: number,
  attempt: number
): Record<string, unknown> {
  const run = record(raw, 'canary execution');
  const repository = record(run.repository, 'execution repository');
  const head = record(run.head_repository, 'execution head repository');
  positive(repository.id, 'execution repository ID');
  positive(head.id, 'execution head repository ID');
  positive(run.run_number, 'canary run number');
  if (
    run.id !== execution.runId ||
    run.run_attempt !== attempt ||
    run.workflow_id !== workflowId ||
    run.path !== '.github/workflows/canary.yml' ||
    !['schedule', 'workflow_dispatch'].includes(String(run.event)) ||
    run.head_branch !== 'main' ||
    run.head_sha !== execution.executionRevision ||
    run.html_url !== `https://github.com/${execution.repository}/actions/runs/${execution.runId}` ||
    repository.id !== repositoryId ||
    head.id !== repositoryId ||
    repository.full_name !== execution.repository ||
    head.full_name !== execution.repository
  )
    throw new Error(
      `Invalid canary execution identity: expected main canary run ${execution.runId} attempt ${attempt}, ${execution.repository} (${repositoryId}), workflow ${workflowId} at ${execution.executionRevision}; received ${JSON.stringify({ runId: run.id, attempt: run.run_attempt, workflowId: run.workflow_id, path: run.path, event: run.event, branch: run.head_branch, executionRevision: run.head_sha, repositoryId: repository.id, headRepositoryId: head.id })}`
    );
  return run;
}
function assertCiRepositories(raw: unknown, repository: string, id: number): void {
  const run = record(raw, 'selected CI');
  const own = record(run.repository, 'selected CI repository');
  const head = record(run.head_repository, 'selected CI head repository');
  positive(own.id, 'selected CI repository ID');
  positive(head.id, 'selected CI head repository ID');
  if (
    own.id !== id ||
    head.id !== id ||
    own.full_name !== repository ||
    head.full_name !== repository
  )
    throw new Error('Invalid selected CI repository: expected current repository IDs and names');
}
function sameSource(left: CanarySource, right: CanarySource): boolean {
  return (
    [
      'repository',
      'sourceSha',
      'runId',
      'runAttempt',
      'runNumber',
      'workflowId',
      'workflowPath',
      'runUrl',
    ] as const
  ).every((key) => left[key] === right[key]);
}
async function workflow(
  deps: CanarySourceSnapshotDependencies,
  base: string,
  name: string
): Promise<number> {
  const value = record(await get(deps, `${base}/actions/workflows/${name}`), 'workflow');
  if (value.path !== `.github/workflows/${name}` || value.state !== 'active')
    throw new Error(`Invalid source workflow: expected active ${name}`);
  return positive(value.id, 'workflow ID');
}
async function get(deps: CanarySourceSnapshotDependencies, path: string): Promise<unknown> {
  const response = await deps.github.getJson(path);
  ok(response.status, path);
  return response.body;
}
function ok(status: number, name: string): void {
  if (status !== 200) throw new Error(`Snapshot ${name}: expected HTTP200; received HTTP${status}`);
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${name}: expected object`);
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}: expected positive safe integer; received ${String(value)}`);
  return value;
}
function timestamp(value: unknown, name: string): number {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    const parsed = Date.parse(value);
    if (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value)
    )
      return parsed;
  }
  throw new Error(
    `Invalid ${name}: expected canonical UTC ISO timestamp; received ${JSON.stringify(value)}`
  );
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function unavailable(attempt: number, reason: string): Error {
  return new Error(
    `Frozen canary source unavailable for successful source attempt ${attempt}: ${reason}; restore the original source snapshot or start a new canary execution, never retarget this rerun`
  );
}
