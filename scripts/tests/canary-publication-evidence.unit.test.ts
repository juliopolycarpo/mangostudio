import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  assertCanaryManifestIdentity,
  type CanaryPromotionReceipt,
  createCanaryPublicationEvidence,
  parseCanaryPromotionReceipt,
  sameApprovedArtifact,
} from '../lib/canary-publication-evidence';
import type { DistributionManifest } from '../lib/distribution-manifest';
import { createReleaseAssetPlan, selectCanaryAssets } from '../lib/release-assets';

function fixture() {
  const sha = 'a'.repeat(40);
  const version = '1.0.0-canary.aaaaaaa';
  const plan = createReleaseAssetPlan({ version });
  const selected = selectCanaryAssets(plan);
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: sha,
    packageVersion: version,
    dirty: false,
    channel: 'canary',
    runtimeProfile: 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'b'.repeat(40),
    targets: [],
    files: [...selected.archives, ...selected.rawBinaries, ...selected.scripts].map((name) => ({
      path: `release-assets/${name}`,
      size: 5,
      sha256: 'c'.repeat(64),
    })),
  };
  const raw = JSON.stringify(manifest);
  const source = { repository: 'owner/repo', sourceSha: sha, runId: 10, runAttempt: 3 };
  const artifact = (scope: string, id: number) => ({
    ...source,
    producerAttempt: 1,
    artifactId: id,
    artifactName: `distribution-${scope}-${sha.slice(0, 12)}-${version}-${'b'.repeat(12)}`,
    digest: `sha256:${'d'.repeat(64)}`,
  });
  const receipt: CanaryPromotionReceipt = {
    schemaVersion: 1,
    selectedRun: {
      ...source,
      runNumber: 20,
      workflowId: 42,
      workflowPath: '.github/workflows/ci.yml',
      runUrl: 'https://github.com/owner/repo/actions/runs/10',
    },
    workflowRevision: 'e'.repeat(40),
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
    distribution: {
      checksums: artifact('checksums', 1),
      assets: artifact('assets', 2),
      npm: artifact('npm', 3),
      builtAt: '2026-11-04T10:00:00Z',
    },
    qualification: {
      source,
      builderAttempt: 1,
      ciJobs: [],
      siblings: [],
      relevance: { cargo: true, protocol: true, reason: 'required' },
    },
  };
  return { raw, manifest, receipt, sha };
}
test('reproduces complete expected release map and durable evidence without binary IO', () => {
  const { raw, receipt, sha } = fixture();
  const bundle = new Uint8Array([1, 2, 3]);
  const evidence = createCanaryPublicationEvidence(raw, receipt, bundle);
  expect(evidence.expected.sourceSha).toBe(sha);
  expect(
    evidence.expected.assets.find((asset) => asset.name === 'promotion-checksums.tar.gz')?.sha256
  ).toBe(createHash('sha256').update(bundle).digest('hex'));
  expect(
    JSON.parse(Buffer.from(evidence.generated.get('canary-manifest.json') ?? []).toString()).builtAt
  ).toBe(receipt.distribution.builtAt);
  expect(Buffer.from(evidence.generated.get('SHA256SUMS') ?? []).toString()).toContain(
    'promotion.json'
  );
  expect(parseCanaryPromotionReceipt(JSON.stringify(receipt), 'owner/repo', sha)).toEqual(receipt);
  assertCanaryManifestIdentity(raw, receipt);
  expect(() => assertCanaryManifestIdentity(`${raw}\n`, receipt)).toThrow(
    'Mixed distribution manifest'
  );
  expect(
    sameApprovedArtifact(receipt.distribution.npm, { ...receipt.distribution.npm, runAttempt: 4 })
  ).toBe(true);
  expect(
    sameApprovedArtifact(receipt.distribution.npm, { ...receipt.distribution.npm, artifactId: 5 })
  ).toBe(false);
});
test.each([
  'schema',
  'workflow',
  'manifest',
  'source',
  'attempt',
  'builder',
  'digest',
  'time',
  'null',
])('rejects invalid persisted evidence %s', (kind) => {
  const { receipt, sha } = fixture();
  const changed = structuredClone(receipt);
  if (kind === 'schema') Object.assign(changed, { schemaVersion: 2 });
  if (kind === 'workflow') Object.assign(changed, { workflowRevision: 'main' });
  if (kind === 'manifest') Object.assign(changed, { manifestSha256: 'broken' });
  if (kind === 'source') Object.assign(changed.qualification.source, { sourceSha: 'b'.repeat(40) });
  if (kind === 'attempt') Object.assign(changed.distribution.npm, { runAttempt: 4 });
  if (kind === 'builder') Object.assign(changed.qualification, { builderAttempt: 4 });
  if (kind === 'digest') Object.assign(changed.distribution.npm, { digest: 'broken' });
  if (kind === 'time') Object.assign(changed.distribution, { builtAt: 'yesterday' });
  expect(() =>
    parseCanaryPromotionReceipt(JSON.stringify(kind === 'null' ? null : changed), 'owner/repo', sha)
  ).toThrow();
});
test('refuses missing files and mismatched authenticated manifest', () => {
  const { raw, manifest, receipt } = fixture();
  expect(() =>
    createCanaryPublicationEvidence(
      raw,
      { ...receipt, manifestSha256: 'f'.repeat(64) },
      new Uint8Array()
    )
  ).toThrow('expected clean shipping');
  const missing = JSON.stringify({ ...manifest, files: [] });
  expect(() =>
    createCanaryPublicationEvidence(
      missing,
      { ...receipt, manifestSha256: createHash('sha256').update(missing).digest('hex') },
      new Uint8Array()
    )
  ).toThrow('Missing approved release asset');
});

test.each([
  'revision-array',
  'manifest-array',
  'digest-array',
  'jobs-object',
  'relevance-shape',
  'siblings-object',
  'invalid-date',
])('refuses malformed persisted receipt shape %s', (kind) => {
  const { receipt, sha } = fixture();
  if (kind === 'revision-array')
    Object.assign(receipt, { workflowRevision: [receipt.workflowRevision] });
  if (kind === 'manifest-array')
    Object.assign(receipt, { manifestSha256: [receipt.manifestSha256] });
  if (kind === 'digest-array')
    Object.assign(receipt.distribution.npm, { digest: [receipt.distribution.npm.digest] });
  if (kind === 'jobs-object') Object.assign(receipt.qualification, { ciJobs: {} });
  if (kind === 'siblings-object') Object.assign(receipt.qualification, { siblings: {} });
  if (kind === 'relevance-shape')
    Object.assign(receipt.qualification, {
      relevance: { cargo: 'false', protocol: false, reason: 'unproven' },
    });
  if (kind === 'invalid-date')
    Object.assign(receipt.distribution, { builtAt: '2026-11-31T10:00:00Z' });
  expect(() => parseCanaryPromotionReceipt(JSON.stringify(receipt), 'owner/repo', sha)).toThrow();
});

test('validates full job and sibling receipt structures without authenticating their claims', () => {
  const { receipt, sha } = fixture();
  Object.assign(receipt.qualification, {
    ciJobs: [{ id: 10, name: 'CI Gate', attempt: 3 }],
    siblings: [
      {
        workflow: 'codeql.yml',
        runId: 20,
        attempt: 1,
        result: 'success',
        jobs: [{ id: 21, name: 'Analyze (rust)', attempt: 1 }],
      },
      {
        workflow: 'protocol-ci.yml',
        runId: null,
        attempt: null,
        result: 'not-triggered',
        jobs: [],
      },
    ],
  });
  expect(parseCanaryPromotionReceipt(JSON.stringify(receipt), 'owner/repo', sha)).toEqual(receipt);
  Object.assign(receipt.qualification, { ciJobs: [{ id: 0, name: 'CI Gate', attempt: 4 }] });
  expect(() => parseCanaryPromotionReceipt(JSON.stringify(receipt), 'owner/repo', sha)).toThrow(
    'expected positive safe integer'
  );
});

test('retains frozen workflow and run identity separately from publisher revision', () => {
  const { raw, receipt, sha } = fixture();
  expect(
    createCanaryPublicationEvidence(raw, receipt, new Uint8Array([1])).generated.has(
      'promotion.json'
    )
  ).toBe(true);
  Object.assign(receipt.selectedRun, { workflowId: 0 });
  expect(() => parseCanaryPromotionReceipt(JSON.stringify(receipt), 'owner/repo', sha)).toThrow(
    'selected run workflowId'
  );
});
