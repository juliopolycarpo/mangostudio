import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { CanaryDistribution } from './canary-promotion';
import {
  assertCanaryManifestIdentity,
  type CanaryPromotionReceipt,
  parseCanaryPromotionReceipt,
} from './canary-publication-evidence';
import type { CanarySource } from './canary-source';
import { type DistributionManifest, parseDistributionManifest } from './distribution-manifest';
import { isValidSemver, normalizeVersion } from './release-version';

type Response<T> = { readonly status: number; readonly body: T };
/** Read boundary retaining real status and every page; transport/incomplete reads reject. */
export interface CanaryApprovalApi {
  getJson(path: string): Promise<Response<unknown>>;
  list(path: string, key?: string): Promise<readonly unknown[]>;
  readBytes(path: string, accept?: string): Promise<Response<Uint8Array>>;
  getRelease(tag: string): Promise<Response<unknown>>;
  resolveTag(tag: string): Promise<Response<unknown>>;
  listAssets(id: number): Promise<readonly unknown[]>;
  readAsset(id: number): Promise<Response<Uint8Array>>;
}
/** Cryptographic verification policy; defaults bind the reviewed main workflow revision. */
export interface CanaryApprovalAttestation {
  readonly workflow: 'canary.yml' | 'distribution-build.yml';
  readonly sourceSha: string;
  readonly sourceRef: 'refs/heads/main';
  readonly signerSha: string;
}
/** Project-owned dependencies. unzip must faithfully list every ZIP member without materializing paths. */
export interface CanaryApprovalDependencies {
  readonly github: CanaryApprovalApi;
  verifyAttestation(bytes: Uint8Array, policy: CanaryApprovalAttestation): Promise<void>;
  unzip(bytes: Uint8Array): Promise<ReadonlyMap<string, Uint8Array>>;
  resolveDistribution(source: CanarySource, version: string): Promise<CanaryDistribution>;
  /** Perform existing immutable CI ID/digest/producer verification before returning the sole bundle. */
  downloadCiChecksums(distribution: CanaryDistribution): Promise<Uint8Array>;
}
/** The exact successful approval artifact, including the earliest reserved identity. */
export interface CanaryApprovalPointer {
  readonly runId: number;
  readonly runNumber: number;
  readonly producerAttempt: number;
  readonly jobId: number;
  readonly artifactId: number;
  readonly artifactName: string;
  readonly artifactDigest: string;
  readonly payloadSha256: string;
  readonly executionRevision: string;
}
/** Original approved distribution recovered without recompilation. */
export interface CanaryApprovalAcquisition {
  readonly origin: 'release' | 'actions' | 'ci';
  readonly receipt?: CanaryPromotionReceipt;
  readonly promotionRaw?: string;
  readonly distribution: CanaryDistribution;
  readonly manifestRaw: string;
  readonly checksumsBundle: Uint8Array;
  readonly pushContextRaw?: string;
  readonly approvalPayload?: Uint8Array;
  readonly approvalPointer?: CanaryApprovalPointer;
  readonly earliestApproval?: CanaryApprovalPointer;
}
interface Candidate {
  readonly pointer: CanaryApprovalPointer;
  readonly expired: boolean;
  readonly size: number;
}
const LIMIT = 64 * 1024 * 1024;

/**
 * Recover the original version approval before considering the current CI bytes.
 * Durable signed release evidence wins; otherwise the earliest successful version
 * reservation fixes one payload hash, including expired/deleted reservations.
 * Integrity rejection never falls back to a rebuild or a later different payload.
 * An explicit payload pin requires recovered evidence before reading fresh CI bytes.
 * Example: await loadCanaryApproval(selectedRun, version, executionSha, dependencies).
 */
export async function loadCanaryApproval(
  source: CanarySource,
  version: string,
  workflowRevision: string,
  deps: CanaryApprovalDependencies,
  expectedApprovalSha256?: string
): Promise<CanaryApprovalAcquisition> {
  validateSelection(source, version, workflowRevision);
  if (expectedApprovalSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedApprovalSha256))
    throw new Error(
      `Invalid EXPECTED_APPROVAL_SHA256: expected full lowercase SHA256; received ${expectedApprovalSha256}`
    );
  const durable = await recoverRelease(source, version, deps);
  if (durable) return pinnedApproval(durable, expectedApprovalSha256);
  const historical = await recoverActions(source, version, deps);
  if (historical) return pinnedApproval(historical, expectedApprovalSha256);
  if (expectedApprovalSha256 !== undefined)
    throw new Error(
      `Approved payload unavailable: expected existing approval SHA256 ${expectedApprovalSha256}; refusing new approval`
    );
  const distribution = await deps.resolveDistribution(source, version);
  for (const scope of ['checksums', 'assets', 'npm'] as const) {
    const item = distribution[scope];
    if (
      item.repository !== source.repository ||
      item.sourceSha !== source.sourceSha ||
      item.runId !== source.runId ||
      item.runAttempt !== source.runAttempt
    )
      throw new Error(
        'Invalid fresh CI distribution: expected exact frozen source, run and attempt'
      );
  }
  const bundle = await deps.downloadCiChecksums(distribution);
  const verified = await verifyBuilderBundle(bundle, source, version, deps);
  return { origin: 'ci', distribution, checksumsBundle: bundle, ...verified };
}

function pinnedApproval(
  acquisition: CanaryApprovalAcquisition,
  expectedSha256: string | undefined
): CanaryApprovalAcquisition {
  if (
    expectedSha256 !== undefined &&
    (!acquisition.approvalPayload || hash(acquisition.approvalPayload) !== expectedSha256)
  )
    throw new Error(
      `Approved payload unavailable: expected existing approval SHA256 ${expectedSha256}; refusing new approval`
    );
  return acquisition;
}

async function recoverRelease(
  source: CanarySource,
  version: string,
  deps: CanaryApprovalDependencies
): Promise<CanaryApprovalAcquisition | undefined> {
  const tag = `v${version}`;
  const response = await deps.github.getRelease(tag);
  if (response.status === 404) return undefined;
  ok(response.status, 'release evidence');
  const release = object(response.body, 'release evidence');
  const id = positive(release.id, 'release ID');
  const url = `https://github.com/${source.repository}/releases/tag/`;
  const draft = release.draft === true;
  if (
    release.tag_name !== tag ||
    release.prerelease !== true ||
    typeof release.draft !== 'boolean' ||
    release.url !== `https://api.github.com/repos/${source.repository}/releases/${id}` ||
    (release.html_url !== `${url}${tag}` &&
      !(
        draft &&
        typeof release.html_url === 'string' &&
        release.html_url.startsWith(`${url}untagged-`) &&
        /^[a-f0-9]+$/.test(release.html_url.slice(`${url}untagged-`.length))
      )) ||
    (!draft && release.immutable !== true)
  )
    throw new Error(
      'Invalid durable canary release: expected source-associated immutable prerelease or recoverable draft'
    );
  const resolved = await deps.github.resolveTag(tag);
  if (draft && resolved.status === 404) {
    if (release.target_commitish !== source.sourceSha)
      throw new Error('Invalid tagless draft source: expected exact full selected SHA');
  } else {
    ok(resolved.status, 'release tag');
    if (resolved.body !== source.sourceSha)
      throw new Error('Invalid release tag: expected exact full selected SHA');
  }
  const records = await deps.github.listAssets(id);
  const names = [
    'promotion.json',
    'promotion-checksums.tar.gz',
    'SHA256SUMS',
    'promotion-approval.tar.gz',
  ];
  const found = new Map<string, Record<string, unknown>>();
  for (const raw of records) {
    const asset = object(raw, 'release asset');
    if (typeof asset.name !== 'string')
      throw new Error('Invalid release evidence asset name: expected string');
    if (names.includes(asset.name)) {
      if (found.has(asset.name)) throw new Error(`Duplicate release evidence asset ${asset.name}`);
      found.set(asset.name, asset);
    }
  }
  if (names.some((name) => !found.has(name) || found.get(name)?.state !== 'uploaded'))
    return undefined;
  const bytes = new Map<string, Uint8Array>();
  for (const name of names) {
    const asset = found.get(name);
    if (!asset) throw new Error(`Missing release evidence asset ${name}`);
    const assetId = positive(asset.id, 'evidence asset ID');
    const size = sizeValue(asset.size, 'evidence asset size');
    const digest = digestValue(asset.digest, 'evidence asset digest');
    const downloaded = await deps.github.readAsset(assetId);
    ok(downloaded.status, `release evidence ${name}`);
    if (downloaded.body.byteLength !== size || hash(downloaded.body) !== digest.slice(7))
      throw new Error(`Corrupt release evidence ${name}: expected size and SHA256 ${digest}`);
    bytes.set(name, downloaded.body);
  }
  const promotion = required(bytes, 'promotion.json');
  const receipt = parseCanaryPromotionReceipt(text(promotion), source.repository, source.sourceSha);
  const sums = required(bytes, 'SHA256SUMS');
  await deps.verifyAttestation(sums, policy('canary.yml', receipt.workflowRevision));
  const checksumMap = checksums(text(sums));
  for (const name of ['promotion.json', 'promotion-checksums.tar.gz', 'promotion-approval.tar.gz'])
    if (checksumMap.get(name) !== hash(required(bytes, name)))
      throw new Error(`Invalid publisher checksum for ${name}: expected exact durable bytes`);
  const payload = required(bytes, 'promotion-approval.tar.gz');
  await deps.verifyAttestation(payload, policy('canary.yml', receipt.workflowRevision));
  const recovered = await verifyApprovalPayload(payload, source, version, deps);
  const archivedPromotion = required(
    readKnownTar(
      payload,
      ['promotion.json', 'promotion-checksums.tar.gz', 'distribution-manifest.json'],
      ['ci-push-context.json']
    ),
    'promotion.json'
  );
  if (
    !equal(required(bytes, 'promotion-checksums.tar.gz'), recovered.checksumsBundle) ||
    !equal(promotion, archivedPromotion)
  )
    throw new Error(
      'Mixed durable promotion evidence: expected the original approval payload files'
    );
  return { ...recovered, origin: 'release', approvalPayload: payload };
}

async function recoverActions(
  source: CanarySource,
  version: string,
  deps: CanaryApprovalDependencies
): Promise<CanaryApprovalAcquisition | undefined> {
  const base = `repos/${source.repository}`;
  const repository = object(await get(deps, base), 'repository');
  const repositoryId = positive(repository.id, 'repository ID');
  if (repository.full_name !== source.repository)
    throw new Error('Invalid repository identity for approval discovery');
  const workflow = object(
    await get(deps, `${base}/actions/workflows/canary.yml`),
    'canary workflow'
  );
  const workflowId = positive(workflow.id, 'canary workflow ID');
  if (workflow.path !== '.github/workflows/canary.yml' || workflow.state !== 'active')
    throw new Error('Invalid approval workflow: expected active canary.yml');
  const runs = await deps.github.list(
    `${base}/actions/workflows/${workflowId}/runs?branch=main&per_page=100`,
    'workflow_runs'
  );
  const candidates: Candidate[] = [];
  const missing: { runNumber: number; attempt: number }[] = [];
  const runNumbers = new Set<number>();
  const jobName = `Approve canary ${version} from ${source.sourceSha}`;
  const prefix = `canary-approval-${source.sourceSha}-${version}-`;
  for (const raw of runs) {
    const run = validateCanaryRun(raw, source.repository, repositoryId, workflowId);
    const runId = positive(run.id, 'canary run ID');
    const runNumber = positive(run.run_number, 'canary run number');
    if (runNumbers.has(runNumber)) throw new Error(`Ambiguous canary run number ${runNumber}`);
    runNumbers.add(runNumber);
    const latest = positive(run.run_attempt, 'latest canary attempt');
    const jobs = (
      await deps.github.list(`${base}/actions/runs/${runId}/jobs?filter=all&per_page=100`, 'jobs')
    )
      .map((rawJob) => object(rawJob, 'approval job'))
      .filter((job) => job.name === jobName);
    const attempts = new Set<number>();
    for (const job of jobs) {
      const attempt = positive(job.run_attempt, 'approval producer attempt');
      positive(job.id, 'approval job ID');
      if (
        attempts.has(attempt) ||
        attempt > latest ||
        job.run_id !== runId ||
        job.head_sha !== run.head_sha
      )
        throw new Error(
          'Invalid approval job: expected unique attempt and associated run/execution SHA'
        );
      attempts.add(attempt);
    }
    const successful = jobs.filter(
      (job) => job.status === 'completed' && job.conclusion === 'success'
    );
    if (successful.length === 0) continue;
    const artifacts = (
      await deps.github.list(`${base}/actions/runs/${runId}/artifacts?per_page=100`, 'artifacts')
    ).map((rawArtifact) => object(rawArtifact, 'approval artifact'));
    for (const artifact of artifacts) {
      if (typeof artifact.name !== 'string')
        throw new Error('Invalid approval artifact name: expected string');
    }
    for (const job of successful) {
      const attempt = positive(job.run_attempt, 'approval producer attempt');
      const started = timestamp(job.started_at, 'approval start');
      const completed = timestamp(job.completed_at, 'approval completion');
      if (completed < started)
        throw new Error('Invalid approval job timestamps: expected ordered interval');
      const named = artifacts.filter(
        (artifact) => typeof artifact.name === 'string' && artifact.name.startsWith(prefix)
      );
      let bound = 0;
      for (const artifact of named) {
        const name = String(artifact.name);
        const suffix = /^([a-f0-9]{64})-([1-9][0-9]*)$/.exec(name.slice(prefix.length));
        if (!suffix)
          throw new Error(
            `Invalid approval artifact name ${name}: expected full payload SHA256 and producer attempt`
          );
        const producer = Number(suffix[2]);
        positive(producer, 'artifact producing attempt');
        if (producer !== attempt) continue;
        bound += 1;
        const association = object(artifact.workflow_run, 'approval artifact workflow_run');
        for (const value of [association.repository_id, association.head_repository_id])
          positive(value, 'artifact repository ID');
        const created = timestamp(artifact.created_at, 'approval artifact creation');
        if (
          association.id !== runId ||
          association.repository_id !== repositoryId ||
          association.head_repository_id !== repositoryId ||
          association.head_sha !== run.head_sha ||
          association.head_branch !== 'main' ||
          created < started ||
          created > completed ||
          typeof artifact.expired !== 'boolean'
        )
          throw new Error(
            `Invalid approval artifact association ${name}: expected successful producing job, repository, run and execution SHA`
          );
        const historical = validateCanaryRun(
          await get(deps, `${base}/actions/runs/${runId}/attempts/${attempt}`),
          source.repository,
          repositoryId,
          workflowId
        );
        if (
          historical.id !== runId ||
          historical.run_attempt !== attempt ||
          historical.run_number !== runNumber ||
          historical.head_sha !== run.head_sha
        )
          throw new Error('Invalid historical approval attempt identity');
        candidates.push({
          pointer: {
            runId,
            runNumber,
            producerAttempt: attempt,
            jobId: positive(job.id, 'approval job ID'),
            artifactId: positive(artifact.id, 'approval artifact ID'),
            artifactName: name,
            artifactDigest: digestValue(artifact.digest, 'approval artifact digest'),
            payloadSha256: suffix[1] ?? '',
            executionRevision: String(run.head_sha),
          },
          expired: artifact.expired,
          size: sizeValue(artifact.size_in_bytes, 'approval ZIP size'),
        });
      }
      if (bound > 1)
        throw new Error(
          'Ambiguous approval artifacts: expected one uploaded reservation per successful attempt'
        );
      if (bound === 0) missing.push({ runNumber, attempt });
    }
  }
  candidates.sort(
    (left, right) =>
      left.pointer.runNumber - right.pointer.runNumber ||
      left.pointer.producerAttempt - right.pointer.producerAttempt
  );
  missing.sort((left, right) => left.runNumber - right.runNumber || left.attempt - right.attempt);
  const earliest = candidates[0];
  const deleted = missing[0];
  if (
    deleted &&
    (!earliest ||
      deleted.runNumber < earliest.pointer.runNumber ||
      (deleted.runNumber === earliest.pointer.runNumber &&
        deleted.attempt <= earliest.pointer.producerAttempt))
  )
    throw new Error(
      'Original canary approval unavailable: successful version reservation has no artifact index; recover original evidence or publish the next source version'
    );
  if (!earliest) return undefined;
  if (new Set(candidates.map((candidate) => candidate.pointer.payloadSha256)).size !== 1)
    throw new Error(
      'Ambiguous approved canary payloads for the same source/version: refuse replacement bytes'
    );
  for (const candidate of candidates.filter((candidate) => !candidate.expired)) {
    const response = await deps.github.readBytes(
      `${base}/actions/artifacts/${candidate.pointer.artifactId}/zip`
    );
    if (response.status === 404 || response.status === 410) continue;
    ok(response.status, 'approval ZIP download');
    if (
      response.body.byteLength !== candidate.size ||
      hash(response.body) !== candidate.pointer.artifactDigest.slice(7)
    )
      throw new Error('Corrupt approval ZIP: expected immutable API size and SHA256 digest');
    const members = await deps.unzip(response.body);
    if (members.size !== 1 || !members.has('approval.tar.gz'))
      throw new Error('Invalid approval ZIP: expected sole flat approval.tar.gz');
    const payload = required(members, 'approval.tar.gz');
    if (hash(payload) !== candidate.pointer.payloadSha256)
      throw new Error('Corrupt approval payload: expected full content-addressed SHA256');
    await deps.verifyAttestation(
      payload,
      policy('canary.yml', candidate.pointer.executionRevision)
    );
    const recovered = await verifyApprovalPayload(payload, source, version, deps);
    return {
      ...recovered,
      origin: 'actions',
      approvalPayload: payload,
      approvalPointer: candidate.pointer,
      earliestApproval: earliest.pointer,
    };
  }
  throw new Error(
    'Original canary approval unavailable: all exact-payload copies are expired or deleted; recover original evidence or publish the next source version'
  );
}

async function verifyApprovalPayload(
  payload: Uint8Array,
  source: CanarySource,
  version: string,
  deps: CanaryApprovalDependencies
): Promise<Omit<CanaryApprovalAcquisition, 'origin'>> {
  const files = readKnownTar(
    payload,
    ['promotion.json', 'promotion-checksums.tar.gz', 'distribution-manifest.json'],
    ['ci-push-context.json']
  );
  const receipt = parseCanaryPromotionReceipt(
    text(required(files, 'promotion.json')),
    source.repository,
    source.sourceSha
  );
  const bundle = required(files, 'promotion-checksums.tar.gz');
  const verified = await verifyBuilderBundle(bundle, source, version, deps);
  assertCanaryManifestIdentity(verified.manifestRaw, receipt);
  for (const scope of ['checksums', 'assets', 'npm'] as const) {
    const prefix = `distribution-${scope}-${source.sourceSha.slice(0, 12)}-${version}-`;
    const name = receipt.distribution[scope].artifactName;
    if (!name.startsWith(prefix) || !/^[a-f0-9]{12}$/.test(name.slice(prefix.length)))
      throw new Error(
        `Invalid original ${scope} artifact name: expected exact source/version and content suffix`
      );
  }
  if (text(required(files, 'distribution-manifest.json')) !== verified.manifestRaw)
    throw new Error('Mixed approval manifest: expected exact original builder manifest');
  const context = files.get('ci-push-context.json');
  if (context && text(context) !== verified.pushContextRaw)
    throw new Error('Mixed approval push context: expected original builder context');
  return {
    receipt,
    promotionRaw: text(required(files, 'promotion.json')),
    distribution: receipt.distribution,
    checksumsBundle: bundle,
    ...verified,
  };
}
async function verifyBuilderBundle(
  bundle: Uint8Array,
  source: CanarySource,
  version: string,
  deps: CanaryApprovalDependencies
): Promise<{ manifestRaw: string; pushContextRaw?: string }> {
  await deps.verifyAttestation(bundle, policy('distribution-build.yml', source.sourceSha));
  const files = readKnownTar(
    bundle,
    ['distribution-manifest.json', 'release-assets/SHA256SUMS'],
    ['ci-push-context.json']
  );
  const raw = text(required(files, 'distribution-manifest.json'));
  const manifest = parseDistributionManifest(raw);
  if (
    manifest.dirty ||
    manifest.runtimeProfile !== 'shipping' ||
    manifest.channel !== 'canary' ||
    manifest.sourceSha !== source.sourceSha ||
    manifest.packageVersion !== version
  )
    throw new Error(
      'Invalid original distribution: expected clean shipping canary with exact source/version'
    );
  verifyManifestChecksums(manifest, required(files, 'release-assets/SHA256SUMS'));
  const context = files.get('ci-push-context.json');
  return { manifestRaw: raw, ...(context ? { pushContextRaw: text(context) } : {}) };
}
function verifyManifestChecksums(manifest: DistributionManifest, bytes: Uint8Array): void {
  const recorded = manifest.files.find((file) => file.path === 'release-assets/SHA256SUMS');
  if (recorded?.size !== bytes.byteLength || recorded.sha256 !== hash(bytes))
    throw new Error('Invalid original checksum file: expected manifest size and SHA256');
  const entries = checksums(text(bytes));
  for (const file of manifest.files.filter(
    (file) => file.path.startsWith('release-assets/') && file.path !== 'release-assets/SHA256SUMS'
  ))
    if (entries.get(file.path.slice('release-assets/'.length)) !== file.sha256)
      throw new Error(`Original checksum identity mismatch ${file.path}`);
}
function checksums(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of raw.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\0\r\n]+)$/.exec(line);
    const name = match?.[2] ?? '';
    const digest = match?.[1] ?? '';
    if (
      digest.length !== 64 ||
      name.length === 0 ||
      name.trim() !== name ||
      ['.', '..'].includes(name) ||
      entries.has(name)
    )
      throw new Error('Invalid SHA256SUMS: expected unique SHA256 and plain basename lines');
    entries.set(name, digest);
  }
  return entries;
}
function readKnownTar(
  bytes: Uint8Array,
  requiredNames: readonly string[],
  optionalNames: readonly string[]
): ReadonlyMap<string, Uint8Array> {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: LIMIT });
  } catch (cause) {
    throw new Error('Invalid approval evidence: expected bounded gzip TAR', { cause });
  }
  if (tar.length % 512 !== 0) throw new Error('Invalid evidence TAR: expected complete blocks');
  const files = new Map<string, Uint8Array>();
  const allowed = new Set([...requiredNames, ...optionalNames]);
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error('Invalid evidence TAR padding');
      ended = true;
      break;
    }
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = rawName === './' ? '.' : rawName.replace(/^\.\//, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : Number.NaN;
    const checksumText = header.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim();
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    const kind = header[156];
    if (
      prefix ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !/^[0-7]+$/.test(checksumText) ||
      Number.parseInt(checksumText, 8) !== sum ||
      ![0, 48, 53].includes(kind ?? -1)
    )
      throw new Error(
        'Invalid evidence TAR header: expected regular known files without links or extensions'
      );
    if (kind === 53) {
      if (
        size !== 0 ||
        !(name === '.' || (name === 'release-assets/' && allowed.has('release-assets/SHA256SUMS')))
      )
        throw new Error('Invalid evidence TAR directory');
    } else {
      if (!allowed.has(name) || files.has(name))
        throw new Error(
          `Invalid evidence TAR member ${JSON.stringify(name)}: expected unique known filename`
        );
      if (offset + 512 + size > tar.length) throw new Error('Truncated evidence TAR member');
      files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || requiredNames.some((name) => !files.has(name)))
    throw new Error('Incomplete evidence TAR: expected all required files and end marker');
  return files;
}
function validateCanaryRun(
  raw: unknown,
  repository: string,
  repositoryId: number,
  workflowId: number
): Record<string, unknown> {
  const run = object(raw, 'canary run');
  const own = object(run.repository, 'canary repository');
  const head = object(run.head_repository, 'canary head repository');
  positive(own.id, 'canary repository ID');
  positive(head.id, 'canary head repository ID');
  const id = positive(run.id, 'canary run ID');
  positive(run.run_attempt, 'canary attempt');
  positive(run.run_number, 'canary run number');
  if (
    own.id !== repositoryId ||
    head.id !== repositoryId ||
    own.full_name !== repository ||
    head.full_name !== repository ||
    run.workflow_id !== workflowId ||
    run.path !== '.github/workflows/canary.yml' ||
    !['schedule', 'workflow_dispatch'].includes(String(run.event)) ||
    run.head_branch !== 'main' ||
    typeof run.head_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    run.html_url !== `https://github.com/${repository}/actions/runs/${id}`
  )
    throw new Error(
      `Invalid canary run: expected ${repository} (${repositoryId}) main schedule/dispatch workflow ${workflowId} and full execution SHA; received ${JSON.stringify({ id: run.id, workflowId: run.workflow_id, path: run.path, event: run.event, branch: run.head_branch, executionSha: run.head_sha, repository: own.full_name, repositoryId: own.id, headRepository: head.full_name, headRepositoryId: head.id })}`
    );
  return run;
}
function validateSelection(source: CanarySource, version: string, revision: string): void {
  for (const value of [source.runId, source.runAttempt, source.runNumber, source.workflowId])
    positive(value, 'selected run identity');
  const short = typeof source.sourceSha === 'string' ? source.sourceSha.slice(0, 7) : '';
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository) ||
    !/^[a-f0-9]{40}$/.test(source.sourceSha) ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    source.workflowPath !== '.github/workflows/ci.yml' ||
    source.runUrl !== `https://github.com/${source.repository}/actions/runs/${source.runId}` ||
    !isValidSemver(version) ||
    normalizeVersion(version) !== version ||
    !version.endsWith(`-canary.${identifier}`)
  )
    throw new Error(
      'Invalid approval selection: expected frozen CI identity, canonical source/version and separate full workflow revision'
    );
}
function policy(
  workflow: CanaryApprovalAttestation['workflow'],
  sha: string
): CanaryApprovalAttestation {
  return { workflow, sourceSha: sha, signerSha: sha, sourceRef: 'refs/heads/main' };
}
async function get(deps: CanaryApprovalDependencies, path: string): Promise<unknown> {
  const response = await deps.github.getJson(path);
  ok(response.status, path);
  return response.body;
}
function ok(status: number, name: string): void {
  if (status !== 200) throw new Error(`Approval ${name}: expected HTTP200; received HTTP${status}`);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${name}: expected object`);
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}: expected positive safe integer; received ${String(value)}`);
  return value;
}
function sizeValue(value: unknown, name: string): number {
  const size = positive(value, name);
  if (size > LIMIT)
    throw new Error(`Invalid ${name}: expected at most ${LIMIT} bytes; received ${size}`);
  return size;
}
function digestValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error(`Invalid ${name}: expected sha256:64 lowercase hex`);
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
  throw new Error(`Invalid ${name}: expected canonical UTC ISO timestamp`);
}
function required(files: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Missing evidence file ${name}`);
  return bytes;
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
