import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { CanaryApprovalAcquisition } from '../lib/canary-approval';
import {
  type CanaryApprovalPreparationServices,
  parseCanaryApprovalSelection,
  prepareCanaryApproval,
} from '../lib/canary-approval-preparation';
import { type CanaryApprovalStageStore, stageApprovedCanary } from '../lib/canary-approval-staging';
import {
  type CanaryPromotionReceipt,
  createCanaryApprovalPayload,
} from '../lib/canary-publication-evidence';
import type { CanarySource } from '../lib/canary-source';
import type { CanaryValidationReceipt } from '../lib/canary-validation';
import type { DistributionManifest } from '../lib/distribution-manifest';
import { createReleaseAssetPlan, selectCanaryAssets } from '../lib/release-assets';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const source: CanarySource = {
    repository: 'owner/repo',
    sourceSha: 'a'.repeat(40),
    runId: 10,
    runAttempt: 3,
    runNumber: 20,
    workflowId: 42,
    workflowPath: '.github/workflows/ci.yml',
    runUrl: 'https://github.com/owner/repo/actions/runs/10',
  };
  const version = '1.0.0-canary.aaaaaaa';
  const selection = selectCanaryAssets(createReleaseAssetPlan({ version }));
  const bytes = Buffer.from('original build');
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: source.sourceSha,
    packageVersion: version,
    dirty: false,
    channel: 'canary',
    runtimeProfile: 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'b'.repeat(40),
    targets: [],
    files: [...selection.archives, ...selection.rawBinaries, ...selection.scripts].map((name) => ({
      path: `release-assets/${name}`,
      size: bytes.byteLength,
      sha256: hash(bytes),
    })),
  };
  const manifestRaw = JSON.stringify(manifest);
  const artifact = (scope: string, id: number) => ({
    repository: source.repository,
    sourceSha: source.sourceSha,
    runId: source.runId,
    runAttempt: source.runAttempt,
    producerAttempt: 1,
    artifactId: id,
    artifactName: `distribution-${scope}-${source.sourceSha.slice(0, 12)}-${version}-${'b'.repeat(12)}`,
    digest: `sha256:${'d'.repeat(64)}`,
  });
  const receipt: CanaryPromotionReceipt = {
    schemaVersion: 1,
    selectedRun: source,
    workflowRevision: 'e'.repeat(40),
    manifestSha256: hash(manifestRaw),
    distribution: {
      checksums: artifact('checksums', 1),
      assets: artifact('assets', 2),
      npm: artifact('npm', 3),
      builtAt: '2026-11-04T10:00:00Z',
    },
    qualification: {
      source: {
        repository: source.repository,
        sourceSha: source.sourceSha,
        runId: 10,
        runAttempt: 3,
      },
      builderAttempt: 1,
      ciJobs: [],
      siblings: [],
      relevance: { cargo: true, protocol: true, reason: 'required' },
    },
  };
  const acquisition: CanaryApprovalAcquisition = {
    origin: 'ci',
    distribution: receipt.distribution,
    manifestRaw,
    checksumsBundle: new Uint8Array([1, 2, 3]),
  };
  const input = { source, version, executionRevision: 'f'.repeat(40), producerAttempt: 2 };
  return { source, version, receipt, acquisition, input, bytes, manifest };
}
class FakeApprovalServices implements CanaryApprovalPreparationServices {
  readonly calls: { source: CanarySource; before?: string }[] = [];
  acquired = 0;
  acquisitionError?: Error;
  qualificationError?: Error;
  qualificationOverride?: (source: CanarySource, before?: string) => CanaryValidationReceipt;
  constructor(readonly acquisition: CanaryApprovalAcquisition) {}
  async acquire(): Promise<CanaryApprovalAcquisition> {
    this.acquired++;
    if (this.acquisitionError) throw this.acquisitionError;
    return await Promise.resolve(this.acquisition);
  }
  async qualify(source: CanarySource, before?: string): Promise<CanaryValidationReceipt> {
    this.calls.push({ source, before });
    if (this.qualificationError) throw this.qualificationError;
    return await Promise.resolve(
      this.qualificationOverride?.(source, before) ?? {
        source: {
          repository: source.repository,
          sourceSha: source.sourceSha,
          runId: source.runId,
          runAttempt: source.runAttempt,
          ...(before ? { pushBeforeSha: before } : {}),
        },
        builderAttempt: 1,
        ciJobs: [],
        siblings: [],
        relevance: { cargo: true, protocol: true, reason: 'required' },
      }
    );
  }
}
class FakeStageStore implements CanaryApprovalStageStore {
  readonly writes: string[] = [];
  readonly stageCalls: unknown[][] = [];
  corrupt?: string;
  constructor(readonly files: Map<string, Uint8Array>) {}
  async stage(version: string, sourceSha: string, builtAt: string): Promise<void> {
    this.stageCalls.push([version, sourceSha, builtAt]);
    await Promise.resolve();
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(name);
    this.files.set(name, bytes);
    await Promise.resolve();
  }
  async read(name: string): Promise<Uint8Array> {
    return await Promise.resolve(
      this.corrupt === name ? new Uint8Array([9]) : (this.files.get(name) ?? new Uint8Array())
    );
  }
}
async function recovered() {
  const f = fixture();
  const payload = await createCanaryApprovalPayload(
    f.acquisition.manifestRaw,
    f.receipt,
    f.acquisition.checksumsBundle
  );
  const acquisition: CanaryApprovalAcquisition = {
    ...f.acquisition,
    origin: 'actions',
    receipt: f.receipt,
    approvalPayload: payload,
    promotionRaw: `${JSON.stringify(f.receipt, null, 2)}\n`,
  };
  return { ...f, acquisition, payload };
}

test('accepts frozen JSON source and string source job outputs', () => {
  const { source, version, input } = fixture();
  expect(
    parseCanaryApprovalSelection(
      JSON.stringify({ source, executionRevision: input.executionRevision }),
      source.repository,
      version,
      input.executionRevision
    )
  ).toEqual(source);
  expect(
    parseCanaryApprovalSelection(
      JSON.stringify({
        repository: source.repository,
        source_sha: source.sourceSha,
        run_id: '10',
        run_attempt: '3',
        run_number: '20',
        run_url: source.runUrl,
        workflow_id: '42',
        workflow_path: source.workflowPath,
        version,
        channel: 'canary',
      }),
      source.repository,
      version,
      input.executionRevision
    )
  ).toEqual(source);
});
test.each([
  'repository',
  'version',
  'channel',
  'executionRevision',
  'runId',
  'workflowPath',
  'null',
  'syntax',
])('rejects malformed selection %s', (kind) => {
  const { source, version, input } = fixture();
  const value = {
    source: { ...source },
    version,
    channel: 'canary',
    executionRevision: input.executionRevision,
  };
  if (kind === 'repository') value.source.repository = 'other/repo';
  if (kind === 'version') value.version = '2.0.0';
  if (kind === 'channel') value.channel = 'stable';
  if (kind === 'executionRevision') value.executionRevision = 'b'.repeat(40);
  if (kind === 'runId') value.source.runId = 0;
  if (kind === 'workflowPath') value.source.workflowPath = '.github/workflows/other.yml';
  expect(() =>
    parseCanaryApprovalSelection(
      kind === 'syntax' ? '{' : JSON.stringify(kind === 'null' ? null : value),
      source.repository,
      version,
      input.executionRevision
    )
  ).toThrow();
});
test('first approval fixes exact CI qualification and creates one original archive', async () => {
  const { input, acquisition } = fixture();
  const service = new FakeApprovalServices(acquisition);
  const result = await prepareCanaryApproval(input, service);
  expect(result.receipt.selectedRun).toEqual(input.source);
  expect(result.receipt.workflowRevision).toBe(input.executionRevision);
  expect(result.receipt.qualification).toEqual(result.currentQualification);
  expect(service.calls).toHaveLength(1);
  expect(result.payloadSha256).toBe(hash(result.approvalPayload));
  expect(result.artifactName).toBe(
    `canary-approval-${input.source.sourceSha}-${input.version}-${result.payloadSha256}-2`
  );
  expect(result.expectedSha256).toBe(hash(result.expectedRaw));
  expect(result.generated.get('promotion-approval.tar.gz')).toBe(result.approvalPayload);
  const members = await new Bun.Archive(result.approvalPayload).files();
  expect(await members.get('promotion.json')?.text()).toBe(result.promotionRaw);
  expect(await members.get('distribution-manifest.json')?.text()).toBe(acquisition.manifestRaw);
});
test('recovered approval preserves exact bytes, original execution, qualification and CI pointers', async () => {
  const f = await recovered();
  const result = await prepareCanaryApproval(
    { ...f.input, expectedApprovalSha256: hash(f.payload) },
    new FakeApprovalServices(f.acquisition)
  );
  expect(result.approvalPayload).toBe(f.payload);
  expect(result.receipt).toBe(f.receipt);
  expect(result.promotionRaw).toBe(f.acquisition.promotionRaw ?? '');
  expect(result.receipt.workflowRevision).not.toBe(f.input.executionRevision);
});
test('npm-only partial publication followed by same-SHA newer CI keeps original distribution and qualifies both', async () => {
  const f = await recovered();
  const current = {
    ...f.source,
    runId: 11,
    runNumber: 21,
    runAttempt: 1,
    runUrl: 'https://github.com/owner/repo/actions/runs/11',
  };
  const context = JSON.stringify({
    repository: f.source.repository,
    after: f.source.sourceSha,
    before: 'b'.repeat(40),
    event: 'push',
    ref: 'refs/heads/main',
  });
  const service = new FakeApprovalServices({ ...f.acquisition, pushContextRaw: context });
  const result = await prepareCanaryApproval({ ...f.input, source: current }, service);
  expect(service.calls.map((call) => [call.source.runId, call.before])).toEqual([
    [11, undefined],
    [10, 'b'.repeat(40)],
  ]);
  expect(result.receipt.selectedRun.runId).toBe(10);
  expect(result.receipt.distribution.npm.artifactId).toBe(3);
  expect(result.approvalPayload).toBe(f.payload);
});
test('same-run earlier producer context remains bound across selected attempts', async () => {
  const f = await recovered();
  const context = JSON.stringify({
    repository: f.source.repository,
    after: f.source.sourceSha,
    before: 'b'.repeat(40),
    event: 'push',
    ref: 'refs/heads/main',
  });
  const service = new FakeApprovalServices({ ...f.acquisition, pushContextRaw: context });
  await prepareCanaryApproval({ ...f.input, source: { ...f.source, runAttempt: 4 } }, service);
  expect(service.calls.map((call) => call.before)).toEqual(['b'.repeat(40), 'b'.repeat(40)]);
});
test.each(['absent', 'wrong', 'malformed'])(
  'publisher pin refuses new or different approval %s before qualification',
  async (kind) => {
    const f = await recovered();
    const service = new FakeApprovalServices(
      kind === 'absent' ? fixture().acquisition : f.acquisition
    );
    await expect(
      prepareCanaryApproval(
        { ...f.input, expectedApprovalSha256: kind === 'malformed' ? 'bad' : '0'.repeat(64) },
        service
      )
    ).rejects.toThrow(kind === 'malformed' ? 'expected full SHA256' : 'refusing new approval');
    expect(service.calls).toHaveLength(0);
  }
);
test.each([
  'receipt-only',
  'missing-original-raw',
  'payload-only',
  'missing-recovery',
  'wrong-qualification',
  'wrong-builder',
  'wrong-version',
  'qualification-error',
  'raw-rewrite',
  'distribution-mismatch',
  'attempt',
])('refuses invalid preparation %s', async (kind) => {
  const f = await recovered();
  let acquisition: CanaryApprovalAcquisition = f.acquisition;
  let input = f.input;
  if (kind === 'missing-original-raw') acquisition = { ...acquisition, promotionRaw: undefined };
  if (kind === 'receipt-only') acquisition = { ...acquisition, approvalPayload: undefined };
  if (kind === 'payload-only') acquisition = { ...acquisition, receipt: undefined };
  if (kind === 'missing-recovery') acquisition = { ...fixture().acquisition, origin: 'release' };
  if (kind === 'raw-rewrite')
    acquisition = { ...acquisition, promotionRaw: JSON.stringify(f.receipt) };
  if (kind === 'distribution-mismatch')
    acquisition = {
      ...acquisition,
      distribution: {
        ...acquisition.distribution,
        npm: { ...acquisition.distribution.npm, artifactId: 99 },
      },
    };
  if (kind === 'wrong-version') input = { ...input, version: '2.0.0-canary.aaaaaaa' };
  if (kind === 'attempt') input = { ...input, producerAttempt: 0 };
  const service = new FakeApprovalServices(acquisition);
  if (kind === 'wrong-qualification')
    service.qualificationOverride = () => ({
      ...f.receipt.qualification,
      source: { ...f.receipt.qualification.source, runId: 99 },
    });
  if (kind === 'wrong-builder')
    service.qualificationOverride = () => ({ ...f.receipt.qualification, builderAttempt: 2 });
  if (kind === 'qualification-error')
    service.qualificationError = new Error('missing native binary proof');
  const expected =
    {
      'receipt-only': 'receipt and exact archive',
      'missing-original-raw': 'receipt and exact archive',
      'payload-only': 'receipt and exact archive',
      'missing-recovery': 'receipt and exact archive',
      'raw-rewrite': 'refusing to rewrite',
      'distribution-mismatch': 'immutable artifact pointers',
      'wrong-version': 'Approval version mismatch',
      attempt: 'producerAttempt',
      'wrong-qualification': 'Qualification identity mismatch',
      'wrong-builder': 'Qualification builder mismatch',
      'qualification-error': 'missing native binary proof',
    }[kind] ?? 'expected invalid preparation';
  await expect(prepareCanaryApproval(input, service)).rejects.toThrow(expected);
});

test('stages original bytes with fixed builtAt and all deterministic evidence', async () => {
  const f = fixture();
  const prepared = await prepareCanaryApproval(f.input, new FakeApprovalServices(f.acquisition));
  const store = new FakeStageStore(
    new Map(f.manifest.files.map((file) => [file.path.replace('release-assets/', ''), f.bytes]))
  );
  const names = await stageApprovedCanary(
    {
      manifestRaw: f.acquisition.manifestRaw,
      receipt: prepared.receipt,
      checksumsBundle: f.acquisition.checksumsBundle,
      approvalPayload: prepared.approvalPayload,
      approvalPayloadSha256: prepared.payloadSha256,
      expectedReleaseSha256: prepared.expectedSha256,
    },
    store
  );
  expect(store.stageCalls).toEqual([
    [f.version, f.source.sourceSha, f.acquisition.distribution.builtAt],
  ]);
  expect(store.files.get('promotion-approval.tar.gz')).toBe(prepared.approvalPayload);
  expect(names).toEqual(
    JSON.parse(prepared.expectedRaw).assets.map((asset: { name: string }) => asset.name)
  );
});
test.each(['manifest', 'payload', 'expected', 'final-bytes'])(
  'refuses staging mismatch %s',
  async (kind) => {
    const f = fixture();
    const prepared = await prepareCanaryApproval(f.input, new FakeApprovalServices(f.acquisition));
    const store = new FakeStageStore(
      new Map(f.manifest.files.map((file) => [file.path.replace('release-assets/', ''), f.bytes]))
    );
    if (kind === 'final-bytes')
      store.corrupt = (f.manifest.files[0]?.path ?? 'missing-fixture').replace(
        'release-assets/',
        ''
      );
    await expect(
      stageApprovedCanary(
        {
          manifestRaw: f.acquisition.manifestRaw + (kind === 'manifest' ? '\n' : ''),
          receipt: prepared.receipt,
          checksumsBundle: f.acquisition.checksumsBundle,
          approvalPayload: prepared.approvalPayload,
          approvalPayloadSha256: kind === 'payload' ? '0'.repeat(64) : prepared.payloadSha256,
          expectedReleaseSha256: kind === 'expected' ? 'bad' : prepared.expectedSha256,
        },
        store
      )
    ).rejects.toThrow(
      {
        manifest: 'Mixed distribution manifest',
        payload: 'Invalid approved archive',
        expected: 'Invalid expected release map',
        'final-bytes': 'Invalid staged asset',
      }[kind] ?? 'expected invalid stage'
    );
    if (kind !== 'final-bytes') expect(store.stageCalls).toHaveLength(0);
  }
);

class FakeApprovalChildCommands {
  constructor(
    readonly directory: string,
    readonly acquisition: CanaryApprovalAcquisition
  ) {}
  install(): void {
    mkdirSync(join(this.directory, 'scripts/ci'), { recursive: true });
    mkdirSync(join(this.directory, 'bin'));
    const fakeGh = join(this.directory, 'bin/gh');
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bun
      import {readFileSync} from 'node:fs';
      const a=JSON.parse(readFileSync('fake-acquisition.json','utf8'));
      const p=a.distribution.checksums;
      const run={id:p.runId,run_attempt:p.runAttempt,run_number:Number(process.env.FAKE_RUN_NUMBER??20),workflow_id:42,path:'.github/workflows/ci.yml',head_sha:p.sourceSha,event:'push',head_branch:'main',html_url:'https://github.com/'+p.repository+'/actions/runs/'+p.runId,repository:{full_name:p.repository},head_repository:{full_name:p.repository},status:'completed',conclusion:'success'};
      console.log('HTTP/2.0 200 OK\\nContent-Type: application/json\\n\\n'+JSON.stringify(run));
    `
    );
    chmodSync(fakeGh, 0o755);
    writeFileSync(
      join(this.directory, 'fake-acquisition.json'),
      JSON.stringify({
        ...this.acquisition,
        checksumsBundle: [...this.acquisition.checksumsBundle],
        approvalPayload: this.acquisition.approvalPayload
          ? [...this.acquisition.approvalPayload]
          : undefined,
      })
    );
    writeFileSync(
      join(this.directory, 'scripts/ci/load-canary-approval.ts'),
      `
      import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const a=JSON.parse(readFileSync('fake-acquisition.json','utf8'));
      const d=process.env.OUTPUT_DIR!; mkdirSync(d,{recursive:true});
      writeFileSync(join(d,'acquisition.json'),JSON.stringify({...a,hasApprovalPayload:!!a.approvalPayload,hasPushContext:!!a.pushContextRaw}));
      writeFileSync(join(d,'distribution-manifest.json'),a.manifestRaw);
      writeFileSync(join(d,'promotion-checksums.tar.gz'),new Uint8Array(a.checksumsBundle));
      if(a.receipt)writeFileSync(join(d,'promotion.json'),a.promotionRaw);
      if(a.approvalPayload)writeFileSync(join(d,'approval.tar.gz'),new Uint8Array(a.approvalPayload));
      if(a.pushContextRaw)writeFileSync(join(d,'ci-push-context.json'),a.pushContextRaw);
    `
    );
    writeFileSync(
      join(this.directory, 'scripts/ci/qualify-canary-source.ts'),
      `
      import {writeFileSync} from 'node:fs';
      const e=process.env;
      writeFileSync(e.QUALIFICATION_RECEIPT!,JSON.stringify({source:{repository:e.REPO,sourceSha:e.SOURCE_SHA,runId:Number(e.SOURCE_RUN_ID),runAttempt:Number(e.SOURCE_RUN_ATTEMPT),...(e.VERIFIED_PUSH_BEFORE_SHA?{pushBeforeSha:e.VERIFIED_PUSH_BEFORE_SHA}:{})},builderAttempt:1,ciJobs:[],siblings:[],relevance:{cargo:true,protocol:true,reason:'FakeQualification'}}));
    `
    );
  }
}
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const prepareCli = resolve(import.meta.dir, '../ci/prepare-canary-approval.ts');
const stageCli = resolve(import.meta.dir, '../ci/stage-approved-canary.ts');

test('default prepare CLI maps source outputs, invokes named child fakes and emits frozen pointer outputs', async () => {
  const f = await recovered();
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-prepare-cli-'));
  try {
    new FakeApprovalChildCommands(directory, f.acquisition).install();
    const output = join(directory, 'output');
    const gha = join(directory, 'gha');
    const run = Bun.spawnSync({
      cmd: [process.execPath, prepareCli],
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
        REPO: f.source.repository,
        VERSION: f.version,
        GITHUB_SHA: f.input.executionRevision,
        GITHUB_RUN_ATTEMPT: '2',
        OUTPUT_DIR: output,
        GITHUB_OUTPUT: gha,
        SOURCE_OUTPUTS_JSON: JSON.stringify({ source: f.source }),
        SELECTION_JSON: undefined,
        EXPECTED_APPROVAL_SHA256: hash(f.payload),
        VERIFIED_PUSH_BEFORE_SHA: 'c'.repeat(40),
      },
    });
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(output, 'approval.tar.gz'))).toEqual(Buffer.from(f.payload));
    expect(readFileSync(join(output, 'promotion.json'), 'utf8')).toBe(
      f.acquisition.promotionRaw ?? ''
    );
    expect(readFileSync(gha, 'utf8')).toContain(`approved_run_id=10\n`);
    expect(readFileSync(gha, 'utf8')).toContain(
      `approval_execution_revision=${f.receipt.workflowRevision}\n`
    );
    expect(readFileSync(gha, 'utf8')).toContain(`assets_id=2\n`);
    expect(readFileSync(gha, 'utf8')).toContain('qualification_json={"current":');
    expect(readFileSync(join(output, 'assets/SHA256SUMS'), 'utf8')).toContain(
      'promotion-approval.tar.gz'
    );
    const expectedRaw = readFileSync(join(output, 'expected-release.json'), 'utf8');
    expect(readFileSync(gha, 'utf8')).toContain(`expected_release_sha256=${hash(expectedRaw)}\n`);
    expect(
      JSON.parse(readFileSync(join(output, 'qualification-current.json'), 'utf8')).source
        .pushBeforeSha
    ).toBeUndefined();
    const changed = Bun.spawnSync({
      cmd: [process.execPath, prepareCli],
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
        REPO: f.source.repository,
        VERSION: f.version,
        GITHUB_SHA: f.input.executionRevision,
        GITHUB_RUN_ATTEMPT: '2',
        OUTPUT_DIR: join(directory, 'changed-output'),
        GITHUB_OUTPUT: gha,
        SELECTION_JSON: JSON.stringify({ source: f.source }),
        EXPECTED_APPROVAL_SHA256: hash(f.payload),
        FAKE_RUN_NUMBER: '99',
      },
    });
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr.toString()).toContain('Frozen CI identity mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('default prepare CLI publisher pin refuses a fresh CI origin and produces no approval', () => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-pin-cli-'));
  try {
    new FakeApprovalChildCommands(directory, f.acquisition).install();
    const run = Bun.spawnSync({
      cmd: [process.execPath, prepareCli],
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
        REPO: f.source.repository,
        VERSION: f.version,
        GITHUB_SHA: f.input.executionRevision,
        GITHUB_RUN_ATTEMPT: '2',
        OUTPUT_DIR: join(directory, 'output'),
        GITHUB_OUTPUT: join(directory, 'gha'),
        SELECTION_JSON: JSON.stringify({ source: f.source }),
        EXPECTED_APPROVAL_SHA256: '0'.repeat(64),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('refusing new approval');
    expect(() => readFileSync(join(directory, 'output/approval.tar.gz'))).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('default stage CLI copies original files and metadata with the frozen builder time', async () => {
  const f = fixture();
  const prepared = await prepareCanaryApproval(f.input, new FakeApprovalServices(f.acquisition));
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-stage-cli-'));
  try {
    const approvalDir = join(directory, 'approval');
    const assetDir = join(directory, 'assets');
    const stageDir = join(directory, 'staged');
    mkdirSync(approvalDir);
    mkdirSync(assetDir);
    writeFileSync(join(approvalDir, 'promotion.json'), prepared.promotionRaw);
    writeFileSync(join(approvalDir, 'promotion-checksums.tar.gz'), f.acquisition.checksumsBundle);
    writeFileSync(join(approvalDir, 'approval.tar.gz'), prepared.approvalPayload);
    const manifestPath = join(directory, 'original-manifest.json');
    writeFileSync(manifestPath, f.acquisition.manifestRaw);
    for (const file of f.manifest.files)
      writeFileSync(join(assetDir, file.path.replace('release-assets/', '')), f.bytes);
    const env = {
      ...process.env,
      APPROVAL_DIR: approvalDir,
      ASSET_DIR: assetDir,
      STAGE_DIR: stageDir,
      MANIFEST_PATH: manifestPath,
      REPO: f.source.repository,
      SOURCE_SHA: f.source.sourceSha,
      EXPECTED_APPROVAL_SHA256: prepared.payloadSha256,
      EXPECTED_RELEASE_SHA256: prepared.expectedSha256,
    };
    const run = Bun.spawnSync({ cmd: [process.execPath, stageCli], env });
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(stageDir, 'canary-manifest.json'), 'utf8')).builtAt).toBe(
      f.receipt.distribution.builtAt
    );
    expect(readFileSync(join(stageDir, 'promotion-approval.tar.gz'))).toEqual(
      Buffer.from(prepared.approvalPayload)
    );
    writeFileSync(manifestPath, `${f.acquisition.manifestRaw}\n`);
    const mismatch = Bun.spawnSync({ cmd: [process.execPath, stageCli], env });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr.toString()).toContain('Mixed distribution manifest');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('acquisition authentication failure stops before qualification', async () => {
  const f = fixture();
  const services = new FakeApprovalServices(f.acquisition);
  services.acquisitionError = new Error(
    'GitHub API: expected authenticated HTTP 200; received 401'
  );
  await expect(prepareCanaryApproval(f.input, services)).rejects.toThrow('received 401');
  expect(services.calls).toHaveLength(0);
});
