import { expect, test } from 'bun:test';

import { parseCanaryPushContext, resolveCanaryDistribution } from '../lib/canary-promotion';
import { checksumsBundleMembers } from '../release/bundle-distribution';
const sha = 'a'.repeat(40);
const source = {
  repository: 'owner/repo',
  sourceSha: sha,
  runId: 10,
  runAttempt: 3,
  producerAttempt: 1,
};
const run = {
  id: 10,
  run_attempt: 3,
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  repository: { id: 5, full_name: 'owner/repo' },
  head_repository: { id: 5, full_name: 'owner/repo' },
};
const jobs = [
  {
    name: 'Distribution / Build immutable distribution',
    run_id: 10,
    run_attempt: 1,
    conclusion: 'success',
    started_at: '2026-11-04T10:00:00Z',
    completed_at: '2026-11-04T10:05:00Z',
  },
];
const artifacts = ['checksums', 'assets', 'npm'].map((scope, index) => ({
  id: index + 1,
  name: `distribution-${scope}-${sha.slice(0, 12)}-1.0.0-canary.aaaaaaa-${'b'.repeat(12)}`,
  digest: `sha256:${'c'.repeat(64)}`,
  expired: false,
  created_at: '2026-11-04T10:04:00Z',
  workflow_run: {
    id: 10,
    repository_id: 5,
    head_repository_id: 5,
    head_sha: sha,
    head_branch: 'main',
  },
}));
const version = '1.0.0-canary.aaaaaaa';
test('resolves original immutable artifacts reused by a partial rerun', () => {
  const plan = resolveCanaryDistribution(source, version, { run, jobs, artifacts });
  expect(plan.npm.artifactId).toBe(3);
  expect(plan.checksums.producerAttempt).toBe(1);
  expect(plan.builtAt).toBe(jobs[0]?.completed_at);
});
test.each(['missing', 'ambiguous', 'expired', 'mixed-attempt', 'wrong-run', 'corrupt-digest'])(
  'refuses %s distribution without rebuild fallback',
  (reason) => {
    const changed = structuredClone(artifacts);
    const npm = changed[2];
    if (!npm) throw new Error('Expected npm artifact fixture');
    if (reason === 'missing') changed.pop();
    if (reason === 'ambiguous') changed.push({ ...npm, id: 9 });
    if (reason === 'expired') npm.expired = true;
    if (reason === 'mixed-attempt') npm.created_at = '2026-11-04T11:00:00Z';
    if (reason === 'wrong-run') npm.workflow_run.id = 11;
    if (reason === 'corrupt-digest') npm.digest = 'broken';
    expect(() =>
      resolveCanaryDistribution(source, version, { run, jobs, artifacts: changed })
    ).toThrow();
  }
);
test('requires one actual successful producer and canary version', () => {
  expect(() => resolveCanaryDistribution(source, version, { run, jobs: [], artifacts })).toThrow(
    'expected one completed successful builder'
  );
  expect(() => resolveCanaryDistribution(source, '1.0.0', { run, jobs, artifacts })).toThrow(
    'expected canary semver'
  );
});
const context = {
  repository: 'owner/repo',
  before: 'b'.repeat(40),
  after: sha,
  event: 'push',
  ref: 'refs/heads/main',
} as const;
test('retains exact push range from the authenticated source bundle', () => {
  expect(parseCanaryPushContext(JSON.stringify(context), 'owner/repo', sha)).toEqual(context);
});
test.each([
  { before: 'abc' },
  { after: 'b'.repeat(40) },
  { repository: 'fork/repo' },
  { event: 'pull_request' },
  { ref: 'refs/heads/other' },
])('rejects inconsistent authenticated push context %j', (change) => {
  expect(() =>
    parseCanaryPushContext(JSON.stringify({ ...context, ...change }), 'owner/repo', sha)
  ).toThrow('expected owner/repo main push');
});
test('refuses malformed push context', () => {
  expect(() => parseCanaryPushContext('null', 'owner/repo', sha)).toThrow(
    'expected main push object'
  );
});

test('binds push context to the signed checksums bundle without changing legacy manual bundles', () => {
  expect(checksumsBundleMembers(true)).toEqual([
    'distribution-manifest.json',
    'release-assets/SHA256SUMS',
    'ci-push-context.json',
  ]);
  expect(checksumsBundleMembers(false)).toEqual([
    'distribution-manifest.json',
    'release-assets/SHA256SUMS',
  ]);
});
