import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CanaryPromotionApi,
  resolveCanaryPromotionSource,
} from '../lib/canary-promotion-source';

const source = { repository: 'owner/repo', runId: 100, runAttempt: 3, sourceSha: 'a'.repeat(40) };
const version = '1.0.0-canary.aaaaaaa';
const builderName = 'Distribution / Build immutable distribution';
const startedAt = '2026-11-04T10:00:00Z';
const completedAt = '2026-11-04T10:05:00Z';
const runPath = 'runs/100/attempts/3';
const jobsPath = 'runs/100/jobs?filter=all&per_page=100';
const artifactsPath = 'runs/100/artifacts?per_page=100';

function builder(attempt = 1, patch: Record<string, unknown> = {}) {
  return {
    id: attempt * 1000,
    run_id: 100,
    run_attempt: attempt,
    name: builderName,
    head_sha: source.sourceSha,
    status: 'completed',
    conclusion: 'success',
    started_at: startedAt,
    completed_at: completedAt,
    ...patch,
  };
}
function artifact(scope: string, id: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    name: `distribution-${scope}-${source.sourceSha.slice(0, 12)}-${version}-${'b'.repeat(12)}`,
    digest: `sha256:${'c'.repeat(64)}`,
    expired: false,
    created_at: '2026-11-04T10:04:00Z',
    workflow_run: {
      id: source.runId,
      repository_id: 5,
      head_repository_id: 5,
      head_sha: source.sourceSha,
      head_branch: 'main',
    },
    ...patch,
  };
}
class FakePromotionApi implements CanaryPromotionApi {
  readonly requests: string[] = [];
  readonly values = new Map<string, unknown>([
    ['workflows/ci.yml', { id: 42, path: '.github/workflows/ci.yml', state: 'active' }],
    [
      runPath,
      {
        id: 100,
        run_attempt: 3,
        run_number: 20,
        workflow_id: 42,
        path: '.github/workflows/ci.yml',
        repository: { id: 5, full_name: source.repository },
        head_repository: { id: 5, full_name: source.repository },
        head_sha: source.sourceSha,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/repo/actions/runs/100',
      },
    ],
    [jobsPath, [builder()]],
    [artifactsPath, [artifact('checksums', 1), artifact('assets', 2), artifact('npm', 3)]],
  ]);
  get(path: string): unknown {
    this.requests.push(path);
    const key = path.replace('repos/owner/repo/actions/', '');
    if (!this.values.has(key)) throw new Error(`Unexpected GitHub API request: ${path}`);
    return this.values.get(key);
  }
  list(path: string, _key: string): readonly unknown[] {
    const value = this.get(path);
    if (!Array.isArray(value)) throw new Error(`Expected fake array: ${path}`);
    return value;
  }
  patch(path: string, changes: Record<string, unknown>) {
    this.values.set(path, { ...(this.values.get(path) as object), ...changes });
  }
}

describe('canary distribution metadata resolver', () => {
  test('retains reused earlier builder and immutable publication scope identities', () => {
    const api = new FakePromotionApi();
    const plan = resolveCanaryPromotionSource(source, version, api);
    expect(plan.checksums).toMatchObject({ ...source, producerAttempt: 1, artifactId: 1 });
    expect(plan.assets.artifactId).toBe(2);
    expect(plan.npm.artifactId).toBe(3);
    expect(plan.builtAt).toBe(completedAt);
    expect(api.requests).toEqual([
      'repos/owner/repo/actions/workflows/ci.yml',
      `repos/owner/repo/actions/${runPath}`,
      `repos/owner/repo/actions/${jobsPath}`,
      `repos/owner/repo/actions/${artifactsPath}`,
    ]);
  });
  test('the frozen attempt remains fixed when a later rerun has started', () => {
    const api = new FakePromotionApi();
    api.values.set(jobsPath, [builder(), builder(4, { status: 'in_progress', conclusion: null })]);
    expect(resolveCanaryPromotionSource(source, version, api).checksums.producerAttempt).toBe(1);
  });
  test('selects the newest successful builder through the frozen attempt', () => {
    const api = new FakePromotionApi();
    api.values.set(jobsPath, [
      builder(),
      builder(2, { started_at: '2026-11-04T11:00:00Z', completed_at: '2026-11-04T11:05:00Z' }),
    ]);
    api.values.set(
      artifactsPath,
      ['checksums', 'assets', 'npm'].map((scope, index) =>
        artifact(scope, index + 4, { created_at: '2026-11-04T11:04:00Z' })
      )
    );
    const plan = resolveCanaryPromotionSource(source, version, api);
    expect(plan.checksums.producerAttempt).toBe(2);
    expect(plan.builtAt).toBe('2026-11-04T11:05:00Z');
  });
  for (const patch of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { status: 'in_progress', conclusion: null },
    { status: 'queued', conclusion: null },
  ]) {
    test(`a newer unsuccessful builder blocks reuse: ${JSON.stringify(patch)}`, () => {
      const api = new FakePromotionApi();
      api.values.set(jobsPath, [builder(), builder(2, patch)]);
      expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(
        'expected completed successful builder'
      );
    });
  }
  test.each(['missing', 'ambiguous', 'expired', 'mixed-attempt', 'wrong-run', 'corrupt-digest'])(
    'rejects %s publication scopes',
    (reason) => {
      const api = new FakePromotionApi();
      const artifacts = [artifact('checksums', 1), artifact('assets', 2), artifact('npm', 3)];
      const npm = artifacts[2];
      if (!npm) throw new Error('Missing npm fixture');
      if (reason === 'missing') artifacts.pop();
      if (reason === 'ambiguous') artifacts.push({ ...npm, id: 9 });
      if (reason === 'expired') npm.expired = true;
      if (reason === 'mixed-attempt') npm.created_at = '2026-11-04T11:04:00Z';
      if (reason === 'wrong-run') npm.workflow_run.id = 101;
      if (reason === 'corrupt-digest') npm.digest = 'broken';
      api.values.set(artifactsPath, artifacts);
      const message = ['missing', 'ambiguous', 'mixed-attempt'].includes(reason)
        ? 'Distribution npm: expected exactly one retained artifact'
        : reason === 'expired'
          ? 'Distribution artifact expired: expected false'
          : reason === 'wrong-run'
            ? 'Distribution artifact run ID: expected 100'
            : 'Distribution digest: expected sha256:';
      expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(message);
    }
  );
  for (const patch of [
    { id: 101 },
    { run_attempt: 4 },
    { run_number: 0 },
    { workflow_id: 43 },
    { path: '.github/workflows/wrong.yml' },
    { event: 'pull_request' },
    { head_branch: 'dev' },
    { head_sha: 'b'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { html_url: 'https://example.com/100' },
    { repository: {} },
    { repository: { id: 5, full_name: 'fork/repo' } },
    { head_repository: { id: 6, full_name: source.repository } },
    { head_repository: { id: 5, full_name: 'fork/repo' } },
    { head_repository: null },
  ]) {
    test(`refuses inconsistent frozen metadata ${JSON.stringify(patch)}`, () => {
      const api = new FakePromotionApi();
      api.patch(runPath, patch);
      const message =
        'run_number' in patch
          ? 'CI run number: expected positive safe integer'
          : patch.repository && !('id' in patch.repository)
            ? 'CI repository ID: expected positive safe integer'
            : patch.head_repository === null
              ? 'CI head repository: expected object'
              : 'Frozen CI attempt: expected successful';
      expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(message);
      expect(api.requests).toHaveLength(2);
    });
  }
  test.each([{ id: 0 }, { state: 'disabled_manually' }, { path: '.github/workflows/other.yml' }])(
    'rejects workflow metadata %j',
    (patch) => {
      const api = new FakePromotionApi();
      api.patch('workflows/ci.yml', patch);
      expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(
        'id' in patch
          ? 'CI workflow ID: expected positive safe integer'
          : 'CI workflow: expected active'
      );
      expect(api.requests).toHaveLength(1);
    }
  );
  test.each(
    [
      [],
      [builder(), builder()],
      [builder(4)],
      [builder(1, { run_attempt: 0 })],
      [builder(1, { id: 0 })],
      [builder(1, { run_id: 101 })],
      [builder(1, { head_sha: 'b'.repeat(40) })],
      [builder(1, { started_at: 'not-a-date' })],
      [builder(1, { completed_at: '2026-11-04T09:00:00Z' })],
      [null],
    ].map((jobs) => ({ jobs }))
  )('rejects missing, ambiguous or malformed producing jobs %j', ({ jobs }) => {
    const api = new FakePromotionApi();
    api.values.set(jobsPath, jobs);
    expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(
      jobs[0] === null ? 'CI job: expected object' : 'Distribution producer'
    );
  });
  test('rejects malformed artifact records and invalid version', () => {
    const api = new FakePromotionApi();
    api.values.set(artifactsPath, [{ name: 42 }]);
    expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow('expected string');
    expect(() =>
      resolveCanaryPromotionSource(source, 'not-semver', new FakePromotionApi())
    ).toThrow('expected canary semver');
  });
  test('rejects invalid frozen selection before any API read', () => {
    const api = new FakePromotionApi();
    for (const patch of [
      { repository: 'bad' },
      { sourceSha: 'main' },
      { runId: 0 },
      { runAttempt: 0 },
    ]) {
      expect(() => resolveCanaryPromotionSource({ ...source, ...patch }, version, api)).toThrow();
    }
    expect(api.requests).toEqual([]);
  });
  test('API failures propagate without manufacturing a promotion plan', () => {
    const api = new FakePromotionApi();
    api.values.delete(artifactsPath);
    expect(() => resolveCanaryPromotionSource(source, version, api)).toThrow(
      'Unexpected GitHub API request'
    );
  });
});

const fakePromotionGitHubCli = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const mode = process.env.FAKE_API_MODE;
if (mode === 'api-failure') { console.error('fixture denied API read'); process.exit(1); }
const path = args.at(-1).replace('repos/owner/repo/actions/', '');
const values = JSON.parse(await Bun.file(process.env.FAKE_API_VALUES).text());
if (!(path in values)) { console.error('Unexpected API request: ' + path); process.exit(2); }
const value = values[path];
if (!args.includes('--paginate')) console.log(JSON.stringify(value));
else {
  const key = path.includes('/jobs?') ? 'jobs' : 'artifacts';
  if (mode === 'empty-pages') console.log('[]');
  else if (mode === 'malformed-page') console.log('[{}]');
  else if (mode === 'missing-count') console.log(JSON.stringify([{[key]:value}]));
  else {
    const count = value.length + (mode === 'incomplete-pages' ? 1 : 0);
    const first = {total_count:count,[key]:value.slice(0,1)};
    const second = {total_count:count + (mode === 'changing-count' ? 1 : 0),[key]:value.slice(1)};
    console.log(JSON.stringify([first,second]));
  }
}
`;

test.each([
  'success',
  'api-failure',
  'empty-pages',
  'malformed-page',
  'missing-count',
  'incomplete-pages',
  'changing-count',
])('promotion metadata CLI: %s', (mode) => {
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-promotion-source-cli-'));
  try {
    const valuesPath = join(directory, 'values.json');
    writeFileSync(valuesPath, JSON.stringify(Object.fromEntries(new FakePromotionApi().values)));
    writeFileSync(join(directory, 'gh'), fakePromotionGitHubCli);
    chmodSync(join(directory, 'gh'), 0o755);
    const planPath = join(directory, 'plan.json');
    const outputs = join(directory, 'outputs');
    const result = Bun.spawnSync(['bun', './scripts/ci/resolve-canary-distribution.ts'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_API_MODE: mode,
        FAKE_API_VALUES: valuesPath,
        REPO: source.repository,
        SOURCE_RUN_ID: String(source.runId),
        SOURCE_RUN_ATTEMPT: String(source.runAttempt),
        SOURCE_SHA: source.sourceSha,
        VERSION: version,
        PLAN_PATH: planPath,
        GITHUB_OUTPUT: outputs,
      },
    });
    expect(result.exitCode).toBe(mode === 'success' ? 0 : 1);
    if (mode === 'success') {
      const expected = resolveCanaryPromotionSource(source, version, new FakePromotionApi());
      expect(JSON.parse(readFileSync(planPath, 'utf8'))).toEqual(expected);
      const output = readFileSync(outputs, 'utf8');
      for (const scope of ['checksums', 'assets', 'npm'] as const) {
        expect(output).toContain(`${scope}_id=${expected[scope].artifactId}\n`);
        expect(output).toContain(`${scope}_name=${expected[scope].artifactName}\n`);
        expect(output).toContain(`${scope}_digest=${expected[scope].digest}\n`);
      }
      expect(output).toContain(`builder_attempt=1\nbuilt_at=${completedAt}\n`);
    } else {
      expect(existsSync(planPath)).toBe(false);
      expect(existsSync(outputs)).toBe(false);
      const message =
        mode === 'api-failure'
          ? 'fixture denied API read'
          : mode === 'empty-pages'
            ? 'expected nonempty paginated array'
            : mode === 'malformed-page'
              ? 'expected page.jobs array'
              : mode === 'missing-count'
                ? 'expected page.total_count nonnegative safe integer'
                : mode === 'incomplete-pages'
                  ? 'expected complete jobs collection'
                  : 'expected stable total_count';
      expect(result.stderr.toString()).toContain(message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
