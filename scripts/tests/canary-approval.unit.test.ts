import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  type CanaryApprovalApi,
  type CanaryApprovalAttestation,
  type CanaryApprovalDependencies,
  type CanaryApprovalPointer,
  loadCanaryApproval,
} from '../lib/canary-approval';
import type { CanaryDistribution } from '../lib/canary-promotion';
import type { CanaryPromotionReceipt } from '../lib/canary-publication-evidence';
import type { CanarySource } from '../lib/canary-source';
import type { DistributionManifest } from '../lib/distribution-manifest';

const REPO = 'owner/repo';
const SHA = 'a'.repeat(40);
const VERSION = '1.0.0-canary.aaaaaaa';
const EXECUTION = 'e'.repeat(40);
const ORIGIN = 'd'.repeat(40);
const BASE = `repos/${REPO}`;
const source: CanarySource = {
  repository: REPO,
  sourceSha: SHA,
  runId: 11,
  runAttempt: 2,
  runNumber: 101,
  workflowId: 5,
  workflowPath: '.github/workflows/ci.yml',
  runUrl: `https://github.com/${REPO}/actions/runs/11`,
};
function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
class FakeApprovalApi implements CanaryApprovalApi {
  readonly calls: string[] = [];
  readonly values = new Map<string, { status: number; body: unknown }>();
  readonly pages = new Map<string, readonly unknown[]>();
  readonly binaries = new Map<string, { status: number; body: Uint8Array }>();
  readonly releaseAssets = new Map<number, { status: number; body: Uint8Array }>();
  readonly failures = new Map<string, Error>();
  release: { status: number; body: unknown } = { status: 404, body: { message: 'Not Found' } };
  tag: { status: number; body: unknown } = { status: 200, body: SHA };
  assets: readonly unknown[] = [];
  constructor() {
    this.values.set(BASE, { status: 200, body: { id: 1, full_name: REPO } });
    this.values.set(`${BASE}/actions/workflows/canary.yml`, {
      status: 200,
      body: { id: 20, path: '.github/workflows/canary.yml', state: 'active' },
    });
    this.pages.set(`${BASE}/actions/workflows/20/runs?branch=main&per_page=100|workflow_runs`, []);
  }
  async getJson(path: string) {
    this.calls.push(path);
    const error = this.failures.get(path);
    if (error) throw error;
    const response = this.values.get(path);
    if (!response) throw new Error(`Unexpected fake JSON ${path}`);
    return await Promise.resolve(response);
  }
  async list(path: string, key?: string) {
    this.calls.push(path);
    const error = this.failures.get(path);
    if (error) throw error;
    const response = this.pages.get(`${path}|${key ?? ''}`);
    if (!response) throw new Error(`Unexpected fake list ${path}|${key}`);
    return await Promise.resolve(response);
  }
  async readBytes(path: string) {
    this.calls.push(path);
    const error = this.failures.get(path);
    if (error) throw error;
    const response = this.binaries.get(path);
    if (!response) throw new Error(`Unexpected fake binary ${path}`);
    return await Promise.resolve(response);
  }
  async getRelease(tag: string) {
    this.calls.push(`release:${tag}`);
    const error = this.failures.get('release');
    if (error) throw error;
    return await Promise.resolve(this.release);
  }
  async resolveTag(tag: string) {
    this.calls.push(`tag:${tag}`);
    return await Promise.resolve(this.tag);
  }
  async listAssets(id: number) {
    this.calls.push(`assets:${id}`);
    return await Promise.resolve(this.assets);
  }
  async readAsset(id: number) {
    this.calls.push(`asset:${id}`);
    const response = this.releaseAssets.get(id);
    if (!response) throw new Error(`Unexpected fake release asset ${id}`);
    return await Promise.resolve(response);
  }
}
class FakeApprovalDependencies implements CanaryApprovalDependencies {
  readonly github = new FakeApprovalApi();
  readonly verifications: { digest: string; policy: CanaryApprovalAttestation }[] = [];
  readonly zipContents = new Map<string, ReadonlyMap<string, Uint8Array>>();
  readonly unzipped: string[] = [];
  resolveCalls = 0;
  ciDownloads = 0;
  rejectWorkflow: string | undefined;
  constructor(
    readonly distribution: CanaryDistribution,
    readonly builderBundle: Uint8Array
  ) {}
  async verifyAttestation(bytes: Uint8Array, policy: CanaryApprovalAttestation) {
    this.verifications.push({ digest: hash(bytes), policy });
    if (this.rejectWorkflow === policy.workflow)
      throw new Error(`Named fake invalid signature ${policy.workflow}`);
    await Promise.resolve();
  }
  async unzip(bytes: Uint8Array) {
    const digest = hash(bytes);
    this.unzipped.push(digest);
    const files = this.zipContents.get(digest);
    if (!files) throw new Error('Unexpected fake ZIP bytes');
    return await Promise.resolve(files);
  }
  async resolveDistribution(selected: CanarySource) {
    this.resolveCalls += 1;
    return await Promise.resolve({
      ...this.distribution,
      checksums: {
        ...this.distribution.checksums,
        runId: selected.runId,
        runAttempt: selected.runAttempt,
      },
      assets: {
        ...this.distribution.assets,
        runId: selected.runId,
        runAttempt: selected.runAttempt,
      },
      npm: {
        ...this.distribution.npm,
        runId: selected.runId,
        runAttempt: selected.runAttempt,
        artifactId: 999,
      },
    });
  }
  async downloadCiChecksums() {
    this.ciDownloads += 1;
    return await Promise.resolve(this.builderBundle);
  }
}
async function fixture(
  options: {
    context?: boolean;
    fileContent?: string;
    manifestHash?: string;
    shipping?: boolean;
  } = {}
) {
  const file = Buffer.from(options.fileContent ?? 'approved shipping archive');
  const sums = Buffer.from(`${hash(file)}  app.tar.gz\n`);
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: SHA,
    packageVersion: VERSION,
    channel: 'canary',
    dirty: false,
    runtimeProfile: options.shipping === false ? 'light' : 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'b'.repeat(40),
    targets: [],
    files: [
      { path: 'release-assets/app.tar.gz', size: file.length, sha256: hash(file) },
      { path: 'release-assets/SHA256SUMS', size: sums.length, sha256: hash(sums) },
    ],
  };
  const manifestRaw = Buffer.from(json(manifest)).toString();
  const context = json({
    repository: REPO,
    before: 'b'.repeat(40),
    after: SHA,
    event: 'push',
    ref: 'refs/heads/main',
  });
  const builderFiles: Record<string, string | Uint8Array> = {
    'distribution-manifest.json': manifestRaw,
    'release-assets/SHA256SUMS': sums,
  };
  if (options.context !== false) builderFiles['ci-push-context.json'] = context;
  const builderBundle = await new Bun.Archive(builderFiles, { compress: 'gzip' }).bytes();
  const original = {
    ...source,
    runId: 10,
    runAttempt: 1,
    runNumber: 100,
    runUrl: `https://github.com/${REPO}/actions/runs/10`,
  };
  const artifact = (scope: string, id: number) => ({
    repository: REPO,
    sourceSha: SHA,
    runId: 10,
    runAttempt: 1,
    producerAttempt: 1,
    artifactId: id,
    artifactName: `distribution-${scope}-${SHA.slice(0, 12)}-${VERSION}-${'c'.repeat(12)}`,
    digest: `sha256:${'b'.repeat(64)}`,
  });
  const distribution = {
    checksums: artifact('checksums', 1),
    assets: artifact('assets', 2),
    npm: artifact('npm', 3),
    builtAt: '2026-11-04T10:03:00Z',
  };
  const receipt: CanaryPromotionReceipt = {
    schemaVersion: 1,
    selectedRun: original,
    workflowRevision: ORIGIN,
    manifestSha256: options.manifestHash ?? hash(manifestRaw),
    distribution,
    qualification: {
      source: { repository: REPO, sourceSha: SHA, runId: 10, runAttempt: 1 },
      builderAttempt: 1,
      ciJobs: [],
      siblings: [],
      relevance: { cargo: true, protocol: true, reason: 'required' },
    },
  };
  const promotion = json(receipt);
  const approvalFiles: Record<string, string | Uint8Array> = {
    'promotion.json': promotion,
    'promotion-checksums.tar.gz': builderBundle,
    'distribution-manifest.json': manifestRaw,
  };
  if (options.context !== false) approvalFiles['ci-push-context.json'] = context;
  const payload = await new Bun.Archive(approvalFiles, { compress: 'gzip' }).bytes();
  const deps = new FakeApprovalDependencies(distribution, builderBundle);
  return { deps, receipt, manifest, manifestRaw, builderBundle, payload, promotion, approvalFiles };
}
function addApproval(
  deps: FakeApprovalDependencies,
  payload: Uint8Array,
  options: {
    id?: number;
    number?: number;
    attempt?: number;
    latest?: number;
    expired?: boolean;
    missing?: boolean;
    conclusion?: string;
    jobName?: string;
    execution?: string;
  } = {}
) {
  const id = options.id ?? 200;
  const runNumber = options.number ?? 2;
  const attempt = options.attempt ?? 1;
  const revision = options.execution ?? EXECUTION;
  const run: Record<string, unknown> = {
    id,
    run_number: runNumber,
    run_attempt: options.latest ?? attempt,
    workflow_id: 20,
    path: '.github/workflows/canary.yml',
    event: 'schedule',
    head_branch: 'main',
    head_sha: revision,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    repository: { id: 1, full_name: REPO },
    head_repository: { id: 1, full_name: REPO },
    status: 'completed',
    conclusion: 'failure',
  };
  const runPath = `${BASE}/actions/workflows/20/runs?branch=main&per_page=100|workflow_runs`;
  deps.github.pages.set(runPath, [...(deps.github.pages.get(runPath) ?? []), run]);
  const job: Record<string, unknown> = {
    id: id * 10,
    name: options.jobName ?? `Approve canary ${VERSION} from ${SHA}`,
    run_id: id,
    run_attempt: attempt,
    head_sha: revision,
    status: 'completed',
    conclusion: options.conclusion ?? 'success',
    started_at: '2026-11-04T10:00:00Z',
    completed_at: '2026-11-04T10:05:00Z',
  };
  deps.github.pages.set(`${BASE}/actions/runs/${id}/jobs?filter=all&per_page=100|jobs`, [job]);
  deps.github.values.set(`${BASE}/actions/runs/${id}/attempts/${attempt}`, {
    status: 200,
    body: { ...run, run_attempt: attempt },
  });
  const zip = Buffer.from(`named fake ZIP for ${hash(payload)}`);
  const artifact: Record<string, unknown> = {
    id: id + 1000,
    name: `canary-approval-${SHA}-${VERSION}-${hash(payload)}-${attempt}`,
    digest: `sha256:${hash(zip)}`,
    size_in_bytes: zip.length,
    expired: options.expired ?? false,
    created_at: '2026-11-04T10:04:00Z',
    workflow_run: {
      id,
      repository_id: 1,
      head_repository_id: 1,
      head_sha: revision,
      head_branch: 'main',
    },
  };
  deps.github.pages.set(
    `${BASE}/actions/runs/${id}/artifacts?per_page=100|artifacts`,
    options.missing ? [] : [artifact]
  );
  deps.github.binaries.set(`${BASE}/actions/artifacts/${id + 1000}/zip`, {
    status: 200,
    body: zip,
  });
  deps.zipContents.set(hash(zip), new Map([['approval.tar.gz', payload]]));
  return { run, job, artifact, zip };
}
function durable(
  deps: FakeApprovalDependencies,
  payload: Uint8Array,
  promotion: Uint8Array,
  builderBundle: Uint8Array
) {
  deps.github.release = {
    status: 200,
    body: {
      id: 50,
      tag_name: `v${VERSION}`,
      prerelease: true,
      draft: false,
      immutable: true,
      target_commitish: SHA,
      url: `https://api.github.com/repos/${REPO}/releases/50`,
      html_url: `https://github.com/${REPO}/releases/tag/v${VERSION}`,
    },
  };
  const items = new Map<string, Uint8Array>([
    ['promotion.json', promotion],
    ['promotion-checksums.tar.gz', builderBundle],
    ['promotion-approval.tar.gz', payload],
  ]);
  items.set(
    'SHA256SUMS',
    Buffer.from(`${[...items].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join('\n')}\n`)
  );
  let id = 1;
  deps.github.assets = [...items].map(([name, bytes]) => {
    const assetId = id++;
    deps.github.releaseAssets.set(assetId, { status: 200, body: bytes });
    return {
      id: assetId,
      name,
      size: bytes.length,
      digest: `sha256:${hash(bytes)}`,
      state: 'uploaded',
    };
  });
}

test('new version acquires frozen CI distribution only after proving no prior reservation', async () => {
  const { deps, manifestRaw } = await fixture();
  const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps);
  expect(result.origin).toBe('ci');
  expect(result.manifestRaw).toBe(manifestRaw);
  expect(result.distribution.npm.artifactId).toBe(999);
  expect(deps.resolveCalls).toBe(1);
  expect(deps.ciDownloads).toBe(1);
  expect(deps.verifications[0]?.policy).toEqual({
    workflow: 'distribution-build.yml',
    sourceSha: SHA,
    signerSha: SHA,
    sourceRef: 'refs/heads/main',
  });
});
test('npm-only partial publication reuses earliest approval despite later CI rebuild', async () => {
  const { deps, payload, receipt } = await fixture();
  addApproval(deps, payload);
  const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps);
  expect(result.origin).toBe('actions');
  expect(result.distribution.npm.artifactId).toBe(receipt.distribution.npm.artifactId);
  expect(result.receipt?.selectedRun.runId).toBe(10);
  expect(deps.resolveCalls).toBe(0);
  expect(deps.ciDownloads).toBe(0);
  expect(result.approvalPayload).toEqual(payload);
});
test('older reruns never supersede original run order and successful old producer is reusable', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 202, number: 3 });
  addApproval(deps, payload, { id: 201, number: 1, attempt: 1, latest: 5 });
  const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps);
  const pointer: CanaryApprovalPointer | undefined = result.approvalPointer;
  expect(pointer?.runId).toBe(201);
  expect(pointer?.producerAttempt).toBe(1);
  expect(result.earliestApproval?.runNumber).toBe(1);
  expect(deps.verifications[0]?.policy.sourceSha).toBe(EXECUTION);
});
test('expired original can use only a recoverable exact-payload copy', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 201, number: 1, expired: true });
  addApproval(deps, payload, { id: 202, number: 2 });
  const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps);
  expect(result.approvalPointer?.runId).toBe(202);
  expect(result.earliestApproval?.runId).toBe(201);
  expect(deps.resolveCalls).toBe(0);
});
test('actual404 race can recover another copy with the same frozen full payload hash', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 201, number: 1 });
  addApproval(deps, payload, { id: 202, number: 2 });
  deps.github.binaries.set(`${BASE}/actions/artifacts/1201/zip`, {
    status: 404,
    body: new Uint8Array(),
  });
  expect((await loadCanaryApproval(source, VERSION, EXECUTION, deps)).approvalPointer?.runId).toBe(
    202
  );
});
test.each(['expired', 'deleted'])(
  'missing original approval %s never falls back to fresh CI bytes',
  async (reason) => {
    const { deps, payload } = await fixture();
    addApproval(deps, payload, { expired: reason === 'expired', missing: reason === 'deleted' });
    await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
      'Original canary approval unavailable'
    );
    expect(deps.resolveCalls).toBe(0);
  }
);
test('deleted earliest index cannot be replaced by a later approval', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 201, number: 1, missing: true });
  addApproval(deps, payload, { id: 202, number: 2 });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'successful version reservation has no artifact index'
  );
});
test('an unrelated version deleted approval never blocks a new version', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, {
    missing: true,
    jobName: `Approve canary 2.0.0-canary.aaaaaaa from ${SHA}`,
  });
  expect((await loadCanaryApproval(source, VERSION, EXECUTION, deps)).origin).toBe('ci');
});
test.each(['failure', 'cancelled'])(
  'failed approve job %s cannot reserve a distribution or enable downstream effects',
  async (conclusion) => {
    const { deps, payload } = await fixture();
    addApproval(deps, payload, { conclusion });
    expect((await loadCanaryApproval(source, VERSION, EXECUTION, deps)).origin).toBe('ci');
  }
);
test('different approved payload hashes for one version fail before downloading either', async () => {
  const first = await fixture();
  const second = await fixture({ fileContent: 'different rebuilt archive' });
  addApproval(first.deps, first.payload, { id: 201, number: 1 });
  addApproval(first.deps, second.payload, { id: 202, number: 2 });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, first.deps)).rejects.toThrow(
    'Ambiguous approved canary payloads'
  );
  expect(first.deps.unzipped).toEqual([]);
  expect(first.deps.resolveCalls).toBe(0);
});
test('ZIP corruption blocks before parsing and never retries another copy as a rebuild', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 201, number: 1 });
  addApproval(deps, payload, { id: 202, number: 2 });
  deps.github.binaries.set(`${BASE}/actions/artifacts/1201/zip`, {
    status: 200,
    body: Buffer.from('corrupt'),
  });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Corrupt approval ZIP'
  );
  expect(deps.unzipped).toEqual([]);
  expect(deps.resolveCalls).toBe(0);
});
test('payload corruption cannot silently choose another approved copy', async () => {
  const { deps, payload } = await fixture();
  const added = addApproval(deps, payload);
  deps.zipContents.set(
    hash(added.zip),
    new Map([['approval.tar.gz', Buffer.from('corrupt payload')]])
  );
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Corrupt approval payload'
  );
  expect(deps.resolveCalls).toBe(0);
});
test('ZIP must contain exactly the flat approval tar name', async () => {
  const { deps, payload } = await fixture();
  const added = addApproval(deps, payload);
  deps.zipContents.set(hash(added.zip), new Map([['../approval.tar.gz', payload]]));
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'sole flat approval.tar.gz'
  );
});
test.each(['canary.yml', 'distribution-build.yml'])(
  'invalid %s provenance rejects original recovery without fresh CI',
  async (workflow) => {
    const { deps, payload } = await fixture();
    addApproval(deps, payload);
    deps.rejectWorkflow = workflow;
    await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
      'Named fake invalid signature'
    );
    expect(deps.resolveCalls).toBe(0);
  }
);
test('receipt manifest hash mismatch fails closed', async () => {
  const { deps, payload } = await fixture({ manifestHash: 'f'.repeat(64) });
  addApproval(deps, payload);
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Mixed distribution manifest'
  );
  expect(deps.resolveCalls).toBe(0);
});
test('light CI bundle is never promoted as shipping', async () => {
  const { deps } = await fixture({ shipping: false });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'expected clean shipping'
  );
});
test('legacy missing push context remains explicit for qualification policy', async () => {
  const { deps, payload } = await fixture({ context: false });
  addApproval(deps, payload);
  expect(
    (await loadCanaryApproval(source, VERSION, EXECUTION, deps)).pushContextRaw
  ).toBeUndefined();
});
test('complete durable release evidence authenticates publisher, original payload and builder before reuse', async () => {
  const { deps, payload, promotion, builderBundle } = await fixture();
  durable(deps, payload, promotion, builderBundle);
  const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps);
  expect(result.origin).toBe('release');
  expect(result.approvalPayload).toEqual(payload);
  expect(deps.resolveCalls).toBe(0);
  expect(deps.github.calls.some((call) => call.includes('/actions/'))).toBe(false);
  expect(deps.verifications.map((item) => [item.policy.workflow, item.policy.sourceSha])).toEqual([
    ['canary.yml', ORIGIN],
    ['canary.yml', ORIGIN],
    ['distribution-build.yml', SHA],
  ]);
});
test('incomplete draft evidence falls through to the original Actions approval', async () => {
  const { deps, payload, promotion, builderBundle } = await fixture();
  durable(deps, payload, promotion, builderBundle);
  deps.github.release.body = {
    ...(deps.github.release.body as object),
    draft: true,
    immutable: false,
  };
  deps.github.assets = deps.github.assets.filter(
    (asset) =>
      asset !== null &&
      typeof asset === 'object' &&
      'name' in asset &&
      asset.name !== 'promotion-approval.tar.gz'
  );
  addApproval(deps, payload);
  expect((await loadCanaryApproval(source, VERSION, EXECUTION, deps)).origin).toBe('actions');
});
test('explicit corrupt full durable evidence does not fall through to Actions or CI', async () => {
  const { deps, payload, promotion, builderBundle } = await fixture();
  durable(deps, payload, promotion, builderBundle);
  deps.github.releaseAssets.set(1, { status: 200, body: Buffer.from('corrupt') });
  addApproval(deps, payload);
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Corrupt release evidence'
  );
  expect(deps.github.calls.some((call) => call.includes('/actions/'))).toBe(false);
  expect(deps.resolveCalls).toBe(0);
});
test.each([401, 403, 500])('release HTTP%i never becomes missing evidence', async (status) => {
  const { deps } = await fixture();
  deps.github.release = { status, body: {} };
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    `HTTP${status}`
  );
  expect(deps.resolveCalls).toBe(0);
});
test('network and incomplete index errors remain fatal', async () => {
  const { deps } = await fixture();
  deps.github.failures.set(
    `${BASE}/actions/workflows/20/runs?branch=main&per_page=100`,
    new Error('Named fake incomplete1000run index')
  );
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'incomplete1000run index'
  );
  expect(deps.resolveCalls).toBe(0);
});
test.each([
  { event: 'push' },
  { head_branch: 'other' },
  { path: '.github/workflows/ci.yml' },
  { workflow_id: 5 },
  { repository: { id: 2, full_name: REPO } },
  { head_repository: { id: undefined, full_name: REPO } },
  { head_sha: 'short' },
])('rejects malformed canary execution identity %j', async (mutation) => {
  const { deps, payload } = await fixture();
  const added = addApproval(deps, payload);
  Object.assign(added.run, mutation);
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    /Invalid (canary run|canary .*repository ID)/
  );
  expect(deps.resolveCalls).toBe(0);
});
test.each([
  { repository_id: 2 },
  { repository_id: undefined },
  { head_repository_id: undefined },
  { id: 999 },
  { head_sha: SHA },
  { head_branch: 'other' },
])('rejects malformed approval artifact association %j', async (mutation) => {
  const { deps, payload } = await fixture();
  const added = addApproval(deps, payload);
  Object.assign(added.artifact.workflow_run as object, mutation);
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    /Invalid (artifact repository ID|approval artifact association)/
  );
  expect(deps.resolveCalls).toBe(0);
});
test('rejects TAR links even though archive readers might omit them', async () => {
  const { deps, payload } = await fixture();
  const tar = gunzipSync(payload);
  const header = tar.subarray(0, 512);
  header[156] = 50;
  header.fill(32, 148, 156);
  const checksum = header
    .reduce((total, byte) => total + byte, 0)
    .toString(8)
    .padStart(6, '0');
  header.write(`${checksum}\0 `, 148, 8, 'ascii');
  addApproval(deps, gzipSync(tar));
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'without links or extensions'
  );
});
test('rejects invalid frozen source and independent workflow revision before I/O', async () => {
  const { deps } = await fixture();
  await expect(
    loadCanaryApproval({ ...source, runNumber: 0 }, VERSION, EXECUTION, deps)
  ).rejects.toThrow('positive safe integer');
  await expect(loadCanaryApproval(source, VERSION, 'main', deps)).rejects.toThrow(
    'separate full workflow revision'
  );
  expect(deps.github.calls).toEqual([]);
});

test('publisher signature failure on complete durable evidence never tries Actions', async () => {
  const { deps, payload, promotion, builderBundle } = await fixture();
  durable(deps, payload, promotion, builderBundle);
  deps.rejectWorkflow = 'canary.yml';
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Named fake invalid signature'
  );
  expect(deps.github.calls.some((call) => call.includes('/actions/'))).toBe(false);
});
test('durable checksum manifest must bind promotion bytes even when asset metadata is self-consistent', async () => {
  const { deps, payload, promotion, builderBundle } = await fixture();
  durable(deps, payload, promotion, builderBundle);
  const raw = Buffer.from(
    `${'f'.repeat(64)}  promotion.json\n${hash(builderBundle)}  promotion-checksums.tar.gz\n${hash(payload)}  promotion-approval.tar.gz\n`
  );
  const checksumAsset = deps.github.assets.find(
    (asset) =>
      asset !== null && typeof asset === 'object' && 'name' in asset && asset.name === 'SHA256SUMS'
  ) as { id: number; size: number; digest: string } | undefined;
  if (!checksumAsset) throw new Error('Expected named checksum fixture asset');
  checksumAsset.size = raw.length;
  checksumAsset.digest = `sha256:${hash(raw)}`;
  deps.github.releaseAssets.set(checksumAsset.id, { status: 200, body: raw });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'Invalid publisher checksum for promotion.json'
  );
  expect(deps.resolveCalls).toBe(0);
});
test('mixed durable outer and inner builder bundles cannot be recovered', async () => {
  const original = await fixture();
  const different = await fixture({ fileContent: 'different archive bytes' });
  durable(original.deps, original.payload, original.promotion, different.builderBundle);
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, original.deps)).rejects.toThrow(
    'Mixed durable promotion evidence'
  );
  expect(original.deps.resolveCalls).toBe(0);
});
test.each(['distribution-manifest.json', 'expected-release.json'])(
  'approval archive rejects changed or extra %s',
  async (member) => {
    const { deps, approvalFiles } = await fixture();
    const payload = await new Bun.Archive(
      { ...approvalFiles, [member]: '{}' },
      { compress: 'gzip' }
    ).bytes();
    addApproval(deps, payload);
    await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
      member === 'distribution-manifest.json'
        ? 'Mixed approval manifest'
        : 'expected unique known filename'
    );
    expect(deps.resolveCalls).toBe(0);
  }
);
test('approval ZIP authentication failure never becomes an unavailable-copy fallback', async () => {
  const { deps, payload } = await fixture();
  addApproval(deps, payload, { id: 201, number: 1 });
  addApproval(deps, payload, { id: 202, number: 2 });
  deps.github.binaries.set(`${BASE}/actions/artifacts/1201/zip`, {
    status: 403,
    body: new Uint8Array(),
  });
  await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps)).rejects.toThrow(
    'received HTTP403'
  );
  expect(deps.unzipped).toEqual([]);
});

const fakeGhApprovalExecutable = `#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);appendFileSync(process.env.FAKE_GH_TRACE,JSON.stringify(args)+'\\n');
const fixture=await Bun.file(process.env.FAKE_GH_FIXTURE).json();
if(args[0]==='attestation'&&args[1]==='verify'){
 const bytes=await Bun.file(args[2]).bytes();const digest=createHash('sha256').update(bytes).digest('hex');const expected=fixture.attestations[digest];
 const flag=name=>args[args.indexOf(name)+1];
 if(!expected||flag('--repo')!==fixture.repository||flag('--signer-workflow')!==fixture.repository+'/.github/workflows/'+expected.workflow||flag('--source-digest')!==expected.sha||flag('--signer-digest')!==expected.sha||flag('--source-ref')!=='refs/heads/main'){console.error('Unexpected fake attestation policy');process.exit(99);}
 process.exit(0);
}
const response=fixture.responses[JSON.stringify(args)];if(!response){console.error('Unexpected fake gh command');process.exit(99);}process.stdout.write(Buffer.from(response.stdout,'base64'));process.exit(response.exitCode);
`;
test('CLI recovers exact durable payload and manifests with explicit provenance policy and no Actions fallback', async () => {
  const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-cli-'));
  try {
    const { deps, payload, promotion, builderBundle, manifestRaw } = await fixture();
    durable(deps, payload, promotion, builderBundle);
    const responses: Record<string, { exitCode: number; stdout: string }> = {};
    const headers = (bytes: Uint8Array) =>
      Buffer.concat([Buffer.from('HTTP/2.0 200 OK\r\n\r\n'), bytes]);
    const respond = (args: string[], bytes: Uint8Array) => {
      responses[JSON.stringify(args)] = {
        exitCode: 0,
        stdout: Buffer.from(bytes).toString('base64'),
      };
    };
    respond(
      ['api', '--include', `${BASE}/releases/tags/v${VERSION}`],
      headers(json(deps.github.release.body))
    );
    respond(
      ['api', '--include', `${BASE}/git/ref/tags/v${VERSION}`],
      headers(json({ object: { type: 'commit', sha: SHA } }))
    );
    respond(
      ['api', '--paginate', '--slurp', `${BASE}/releases/50/assets?per_page=100`],
      json([deps.github.assets])
    );
    for (const [id, response] of deps.github.releaseAssets)
      respond(
        [
          'api',
          '--include',
          '--header',
          'Accept: application/octet-stream',
          `${BASE}/releases/assets/${id}`,
        ],
        headers(response.body)
      );
    const checksum = deps.github.assets.find(
      (asset) =>
        asset !== null &&
        typeof asset === 'object' &&
        'name' in asset &&
        asset.name === 'SHA256SUMS'
    ) as { id: number } | undefined;
    const checksumBytes = checksum ? deps.github.releaseAssets.get(checksum.id)?.body : undefined;
    if (!checksumBytes) throw new Error('Expected publisher checksum fixture');
    const attestations = {
      [hash(checksumBytes)]: { workflow: 'canary.yml', sha: ORIGIN },
      [hash(payload)]: { workflow: 'canary.yml', sha: ORIGIN },
      [hash(builderBundle)]: { workflow: 'distribution-build.yml', sha: SHA },
    };
    const fixtureFile = join(directory, 'fake-gh.json');
    writeFileSync(fixtureFile, JSON.stringify({ repository: REPO, responses, attestations }));
    writeFileSync(join(directory, 'gh'), fakeGhApprovalExecutable);
    chmodSync(join(directory, 'gh'), 0o755);
    const output = join(directory, 'output');
    const trace = join(directory, 'trace');
    const outputs = join(directory, 'github-output');
    const proc = Bun.spawnSync(['bun', './scripts/ci/load-canary-approval.ts'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        REPO,
        SOURCE_SHA: SHA,
        SOURCE_RUN_ID: String(source.runId),
        SOURCE_RUN_ATTEMPT: String(source.runAttempt),
        SOURCE_RUN_NUMBER: String(source.runNumber),
        SOURCE_RUN_URL: source.runUrl,
        WORKFLOW_ID: String(source.workflowId),
        WORKFLOW_PATH: source.workflowPath,
        VERSION,
        GITHUB_SHA: EXECUTION,
        OUTPUT_DIR: output,
        GITHUB_OUTPUT: outputs,
        FAKE_GH_TRACE: trace,
        FAKE_GH_FIXTURE: fixtureFile,
      },
    });
    expect(proc.stderr.toString()).toBe('');
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(output, 'acquisition.json'), 'utf8')).origin).toBe(
      'release'
    );
    expect(new Uint8Array(readFileSync(join(output, 'approval.tar.gz')))).toEqual(payload);
    expect(readFileSync(join(output, 'distribution-manifest.json'), 'utf8')).toBe(manifestRaw);
    expect(readFileSync(outputs, 'utf8')).toContain('approval_origin=release');
    expect(readFileSync(trace, 'utf8')).not.toContain('/actions/');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery retains the exact original promotion JSON serialization', async () => {
  const { deps, receipt, approvalFiles } = await fixture();
  const raw = JSON.stringify(receipt);
  const payload = await new Bun.Archive(
    { ...approvalFiles, 'promotion.json': raw },
    { compress: 'gzip' }
  ).bytes();
  addApproval(deps, payload);
  expect((await loadCanaryApproval(source, VERSION, EXECUTION, deps)).promotionRaw).toBe(raw);
});

test('approval CLI rejects an extra whitespace-only ZIP member', async () => {
  const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-extra-member-'));
  try {
    const { deps, payload, builderBundle } = await fixture();
    addApproval(deps, payload);
    const responses: Record<string, { exitCode: number; stdout: string }> = {};
    const respond = (args: string[], status: number, body: Uint8Array, include = true) => {
      responses[JSON.stringify(args)] = {
        exitCode: status >= 400 ? 1 : 0,
        stdout: Buffer.concat([
          include ? Buffer.from(`HTTP/2.0 ${status} Status\r\n\r\n`) : new Uint8Array(),
          body,
        ]).toString('base64'),
      };
    };
    respond(
      ['api', '--include', `${BASE}/releases/tags/v${VERSION}`],
      404,
      json({ message: 'Not Found' })
    );
    respond(
      ['api', '--paginate', '--slurp', `${BASE}/releases?per_page=100`],
      200,
      json([[]]),
      false
    );
    for (const [path, response] of deps.github.values)
      respond(['api', '--include', path], response.status, json(response.body));
    for (const [pageKey, values] of deps.github.pages) {
      const separator = pageKey.lastIndexOf('|');
      const path = pageKey.slice(0, separator);
      const key = pageKey.slice(separator + 1);
      respond(
        ['api', '--paginate', '--slurp', path],
        200,
        json([{ total_count: values.length, [key]: values }]),
        false
      );
    }
    for (const [path, response] of deps.github.binaries)
      respond(['api', '--include', path], response.status, response.body);
    const fixtureFile = join(directory, 'fake-gh.json');
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        repository: REPO,
        responses,
        attestations: {
          [hash(payload)]: { workflow: 'canary.yml', sha: EXECUTION },
          [hash(builderBundle)]: { workflow: 'distribution-build.yml', sha: SHA },
        },
      })
    );
    writeFileSync(join(directory, 'gh'), fakeGhApprovalExecutable);
    chmodSync(join(directory, 'gh'), 0o755);
    const payloadPath = join(directory, 'original-payload');
    writeFileSync(payloadPath, payload);
    writeFileSync(
      join(directory, 'unzip'),
      `#!/usr/bin/env bun\nconst args=process.argv.slice(2);if(args[0]==='-Z1')process.stdout.write('approval.tar.gz\\n \\n');else if(args[0]==='-p'&&args[2]==='approval.tar.gz')process.stdout.write(await Bun.file(process.env.FAKE_APPROVAL_PAYLOAD).bytes());else process.exit(99);\n`
    );
    chmodSync(join(directory, 'unzip'), 0o755);
    const result = Bun.spawnSync(['bun', './scripts/ci/load-canary-approval.ts'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        REPO,
        SOURCE_SHA: SHA,
        SOURCE_RUN_ID: String(source.runId),
        SOURCE_RUN_ATTEMPT: String(source.runAttempt),
        SOURCE_RUN_NUMBER: String(source.runNumber),
        SOURCE_RUN_URL: source.runUrl,
        WORKFLOW_ID: String(source.workflowId),
        WORKFLOW_PATH: source.workflowPath,
        VERSION,
        GITHUB_SHA: EXECUTION,
        OUTPUT_DIR: join(directory, 'output'),
        GITHUB_OUTPUT: join(directory, 'outputs'),
        FAKE_GH_TRACE: join(directory, 'trace'),
        FAKE_GH_FIXTURE: fixtureFile,
        FAKE_APPROVAL_PAYLOAD: payloadPath,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('expected sole flat approval.tar.gz');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit approval pin refuses missing evidence before fresh CI resolution', async () => {
  const { deps } = await fixture();
  await expect(
    loadCanaryApproval(source, VERSION, EXECUTION, deps, '4'.repeat(64))
  ).rejects.toThrow('Approved payload unavailable: expected existing approval SHA256');
  expect(deps.resolveCalls).toBe(0);
  expect(deps.ciDownloads).toBe(0);
});

test.each(['release', 'actions'] as const)(
  'explicit approval pin authenticates original %s evidence across workflow revisions',
  async (origin) => {
    const { deps, payload, promotion, builderBundle } = await fixture();
    if (origin === 'release') durable(deps, payload, promotion, builderBundle);
    else addApproval(deps, payload);
    const result = await loadCanaryApproval(source, VERSION, EXECUTION, deps, hash(payload));
    expect(result.origin).toBe(origin);
    expect(result.approvalPayload).toEqual(payload);
    expect(result.receipt?.workflowRevision).toBe(ORIGIN);
    expect(deps.verifications.length).toBeGreaterThan(0);
    expect(deps.resolveCalls).toBe(0);
    expect(deps.ciDownloads).toBe(0);
    await expect(
      loadCanaryApproval(source, VERSION, EXECUTION, deps, '0'.repeat(64))
    ).rejects.toThrow('Approved payload unavailable: expected existing approval SHA256');
    expect(deps.resolveCalls).toBe(0);
  }
);

test.each(['bad', 'A'.repeat(64)])(
  'malformed explicit approval pin %s fails before acquisition',
  async (pin) => {
    const { deps } = await fixture();
    await expect(loadCanaryApproval(source, VERSION, EXECUTION, deps, pin)).rejects.toThrow(
      'expected full lowercase SHA256'
    );
    expect(deps.github.calls).toEqual([]);
  }
);
