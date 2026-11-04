import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanarySource } from '../lib/canary-source';
import {
  type CanarySourceExecution,
  type CanarySourceResolution,
  type CanarySourceSnapshotDependencies,
  resolveCanarySourceSnapshot,
  writeCanarySourceSnapshot,
} from '../lib/canary-source-snapshot';

const REPO = 'owner/repo';
const BASE = `repos/${REPO}`;
const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const EXECUTION = 'e'.repeat(40);
const VERSION = '1.0.0-canary.aaaaaaa';
const execution: CanarySourceExecution = {
  repository: REPO,
  runId: 200,
  runAttempt: 1,
  executionRevision: EXECUTION,
};
const selected: CanarySource = {
  repository: REPO,
  sourceSha: SHA,
  runId: 10,
  runAttempt: 1,
  runNumber: 100,
  workflowId: 5,
  workflowPath: '.github/workflows/ci.yml',
  runUrl: `https://github.com/${REPO}/actions/runs/10`,
};
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function ciRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    run_attempt: 1,
    run_number: 100,
    workflow_id: 5,
    path: '.github/workflows/ci.yml',
    head_sha: SHA,
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    html_url: selected.runUrl,
    repository: { id: 1, full_name: REPO },
    head_repository: { id: 1, full_name: REPO },
    ...overrides,
  };
}
function canaryRun(attempt: number) {
  return {
    id: 200,
    run_attempt: attempt,
    run_number: 2,
    workflow_id: 20,
    path: '.github/workflows/canary.yml',
    head_sha: EXECUTION,
    event: 'workflow_dispatch',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${REPO}/actions/runs/200`,
    repository: { id: 1, full_name: REPO },
    head_repository: { id: 1, full_name: REPO },
  };
}
function sourceJob(attempt: number, conclusion = 'success') {
  return {
    id: 2000 + attempt,
    name: 'Resolve latest green main commit',
    run_id: 200,
    run_attempt: attempt,
    head_sha: EXECUTION,
    status: 'completed',
    conclusion,
    started_at: '2026-11-04T10:00:00Z',
    completed_at: '2026-11-04T10:05:00Z',
  };
}
class FakeSnapshotDependencies implements CanarySourceSnapshotDependencies {
  readonly calls: string[] = [];
  readonly values = new Map<string, { status: number; body: unknown }>();
  readonly pages = new Map<string, readonly unknown[]>();
  readonly binaries = new Map<string, { status: number; body: Uint8Array }>();
  readonly archives = new Map<string, ReadonlyMap<string, Uint8Array>>();
  readonly unpacked: string[] = [];
  readonly failures = new Map<string, Error>();
  readonly github = {
    getJson: async (path: string) => {
      this.calls.push(path);
      const error = this.failures.get(path);
      if (error) throw error;
      const response = this.values.get(path);
      if (!response) throw new Error(`Unexpected fake snapshot JSON ${path}`);
      return await Promise.resolve(response);
    },
    list: async (path: string, key?: string) => {
      this.calls.push(path);
      const error = this.failures.get(path);
      if (error) throw error;
      const response = this.pages.get(`${path}|${key}`);
      if (!response) throw new Error(`Unexpected fake snapshot pages ${path}|${key}`);
      return await Promise.resolve(response);
    },
    readBytes: async (path: string) => {
      this.calls.push(path);
      const error = this.failures.get(path);
      if (error) throw error;
      const response = this.binaries.get(path);
      if (!response) throw new Error(`Unexpected fake snapshot binary ${path}`);
      return await Promise.resolve(response);
    },
  };
  async unzip(bytes: Uint8Array) {
    const digest = hash(bytes);
    this.unpacked.push(digest);
    const response = this.archives.get(digest);
    if (!response) throw new Error('Unexpected fake snapshot ZIP');
    return await Promise.resolve(response);
  }
  constructor(attempt = 1) {
    this.values.set(BASE, { status: 200, body: { id: 1, full_name: REPO } });
    this.values.set(`${BASE}/actions/workflows/canary.yml`, {
      status: 200,
      body: { id: 20, path: '.github/workflows/canary.yml', state: 'active' },
    });
    this.values.set(`${BASE}/actions/workflows/ci.yml`, {
      status: 200,
      body: { id: 5, path: '.github/workflows/ci.yml', state: 'active' },
    });
    this.values.set(`${BASE}/actions/runs/200/attempts/${attempt}`, {
      status: 200,
      body: canaryRun(attempt),
    });
    this.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, [
      sourceJob(attempt, 'pending'),
    ]);
    this.pages.set(
      `${BASE}/actions/workflows/5/runs?branch=main&event=push&status=success&per_page=100|workflow_runs`,
      [ciRun()]
    );
    this.values.set(`${BASE}/actions/runs/10/attempts/1`, { status: 200, body: ciRun() });
  }
}
function restoredFixture(options: { missing?: boolean; expired?: boolean; raw?: string } = {}) {
  const deps = new FakeSnapshotDependencies(3);
  const raw =
    options.raw ??
    JSON.stringify({
      schemaVersion: 1,
      source: selected,
      version: VERSION,
      channel: 'canary',
      executionRevision: EXECUTION,
    });
  const zip = Buffer.from(`named snapshot ZIP ${hash(Buffer.from(raw))}`);
  const original = sourceJob(1);
  deps.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, [
    sourceJob(3, 'pending'),
    original,
  ]);
  deps.values.set(`${BASE}/actions/runs/200/attempts/1`, { status: 200, body: canaryRun(1) });
  const artifact: Record<string, unknown> = {
    id: 900,
    name: 'canary-source-200-1',
    created_at: '2026-11-04T10:04:00Z',
    expired: options.expired ?? false,
    size_in_bytes: zip.length,
    digest: `sha256:${hash(zip)}`,
    workflow_run: {
      id: 200,
      repository_id: 1,
      head_repository_id: 1,
      head_sha: EXECUTION,
      head_branch: 'main',
    },
  };
  deps.pages.set(
    `${BASE}/actions/runs/200/artifacts?per_page=100|artifacts`,
    options.missing ? [] : [artifact]
  );
  deps.binaries.set(`${BASE}/actions/artifacts/900/zip`, { status: 200, body: zip });
  deps.archives.set(hash(zip), new Map([['source.json', Buffer.from(raw)]]));
  return { deps, raw, zip, artifact, original, context: { ...execution, runAttempt: 3 } };
}
function queriedLatest(deps: FakeSnapshotDependencies): boolean {
  return deps.calls.some((path) => path.includes('/workflows/5/runs?'));
}

test('initial execution selects latest eligible CI and finishes identity after selected checkout', async () => {
  const deps = new FakeSnapshotDependencies();
  const resolved = await resolveCanarySourceSnapshot(execution, deps);
  expect(resolved).toEqual({ source: selected, executionRevision: EXECUTION, restored: false });
  const written = writeCanarySourceSnapshot(resolved, {
    sourceSha: SHA,
    version: VERSION,
    channel: 'canary',
    executionRevision: EXECUTION,
  });
  expect(JSON.parse(written.raw)).toEqual({
    schemaVersion: 1,
    source: selected,
    version: VERSION,
    channel: 'canary',
    executionRevision: EXECUTION,
  });
});
test('full rerun restores original application and CI identity even after a newer main push succeeds', async () => {
  const { deps, raw, context } = restoredFixture();
  deps.pages.set(
    `${BASE}/actions/workflows/5/runs?branch=main&event=push&status=success&per_page=100|workflow_runs`,
    [
      ciRun({
        id: 11,
        run_number: 101,
        head_sha: NEW_SHA,
        html_url: `https://github.com/${REPO}/actions/runs/11`,
      }),
      ciRun(),
    ]
  );
  const result = await resolveCanarySourceSnapshot(context, deps);
  expect(result.source).toEqual(selected);
  expect(result.snapshotRaw).toBe(raw);
  expect(result.originalAttempt).toBe(1);
  expect(queriedLatest(deps)).toBe(false);
  expect(
    writeCanarySourceSnapshot(result, {
      sourceSha: SHA,
      version: VERSION,
      channel: 'canary',
      executionRevision: EXECUTION,
    }).raw
  ).toBe(raw);
});
test('earliest successful source job wins rather than a later full rerun source job', async () => {
  const { deps, context } = restoredFixture();
  const jobs = deps.pages.get(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`) ?? [];
  deps.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, [
    sourceJob(2),
    ...jobs,
  ]);
  expect((await resolveCanarySourceSnapshot(context, deps)).originalAttempt).toBe(1);
});
test.each(['missing', 'expired'])(
  'original source snapshot %s blocks rerun without querying latest',
  async (reason) => {
    const { deps, context } = restoredFixture({
      missing: reason === 'missing',
      expired: reason === 'expired',
    });
    await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
      'Frozen canary source unavailable'
    );
    expect(queriedLatest(deps)).toBe(false);
    expect(deps.unpacked).toEqual([]);
  }
);
test('missing earliest snapshot cannot be replaced by a later available snapshot', async () => {
  const { deps, context, artifact } = restoredFixture({ missing: true });
  deps.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, [
    sourceJob(1),
    sourceJob(2),
    sourceJob(3, 'pending'),
  ]);
  deps.pages.set(`${BASE}/actions/runs/200/artifacts?per_page=100|artifacts`, [
    { ...artifact, id: 901, name: 'canary-source-200-2' },
  ]);
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    'original snapshot missing'
  );
  expect(queriedLatest(deps)).toBe(false);
});
test.each(['failure', 'cancelled'])(
  'no earlier successful source job after %s permits initial selection rules',
  async (conclusion) => {
    const deps = new FakeSnapshotDependencies(3);
    deps.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, [
      sourceJob(1, conclusion),
      sourceJob(3, 'pending'),
    ]);
    deps.pages.set(
      `${BASE}/actions/workflows/5/runs?branch=main&event=push&status=success&per_page=100|workflow_runs`,
      [
        ciRun({
          id: 11,
          run_number: 101,
          head_sha: NEW_SHA,
          html_url: `https://github.com/${REPO}/actions/runs/11`,
        }),
        ciRun(),
      ]
    );
    expect(
      (await resolveCanarySourceSnapshot({ ...execution, runAttempt: 3 }, deps)).source.sourceSha
    ).toBe(NEW_SHA);
    expect(queriedLatest(deps)).toBe(true);
  }
);
test('no eligible CI fails without scheduler HEAD substitution', async () => {
  const deps = new FakeSnapshotDependencies();
  deps.pages.set(
    `${BASE}/actions/workflows/5/runs?branch=main&event=push&status=success&per_page=100|workflow_runs`,
    []
  );
  await expect(resolveCanarySourceSnapshot(execution, deps)).rejects.toThrow(
    'No eligible completed successful'
  );
});
test.each([404, 410, 403, 500])(
  'snapshot binary HTTP%i never triggers latest-source selection',
  async (status) => {
    const { deps, context } = restoredFixture();
    deps.binaries.set(`${BASE}/actions/artifacts/900/zip`, { status, body: new Uint8Array() });
    await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
      status === 404 || status === 410 ? 'Frozen canary source unavailable' : `HTTP${status}`
    );
    expect(queriedLatest(deps)).toBe(false);
  }
);
test('corrupt snapshot ZIP fails before unpacking', async () => {
  const { deps, context } = restoredFixture();
  deps.binaries.set(`${BASE}/actions/artifacts/900/zip`, {
    status: 200,
    body: Buffer.from('corrupt'),
  });
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    'Corrupt source snapshot ZIP'
  );
  expect(deps.unpacked).toEqual([]);
  expect(queriedLatest(deps)).toBe(false);
});
test('source ZIP requires the sole flat source.json member', async () => {
  const { deps, context, zip } = restoredFixture();
  deps.archives.set(hash(zip), new Map([['../source.json', Buffer.from('{}')]]));
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    'sole bounded flat source.json'
  );
});
test.each([
  { schemaVersion: 2 },
  { executionRevision: NEW_SHA },
  { channel: 'latest' },
  { version: '1.0.0-canary.bbbbbbb' },
])('rejects inconsistent source snapshot %j', async (mutation) => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    source: selected,
    version: VERSION,
    channel: 'canary',
    executionRevision: EXECUTION,
    ...mutation,
  });
  const { deps, context } = restoredFixture({ raw });
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    /Invalid (source snapshot|selected application identity)/
  );
  expect(queriedLatest(deps)).toBe(false);
});
test.each(['failure', 'cancelled', 'in_progress'])(
  'selected CI exact attempt must still prove successful workflow, received%s',
  async (conclusion) => {
    const { deps, context } = restoredFixture();
    deps.values.set(`${BASE}/actions/runs/10/attempts/1`, {
      status: 200,
      body: ciRun({
        conclusion,
        status: conclusion === 'in_progress' ? 'in_progress' : 'completed',
      }),
    });
    await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
      'No eligible completed successful'
    );
    expect(queriedLatest(deps)).toBe(false);
  }
);
test('saved CI full metadata must match its exact historical API record', async () => {
  const { deps, context } = restoredFixture();
  deps.values.set(`${BASE}/actions/runs/10/attempts/1`, {
    status: 200,
    body: ciRun({ run_number: 101 }),
  });
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    'exact successful historical run, attempt and metadata'
  );
  expect(queriedLatest(deps)).toBe(false);
});
test.each([
  { repository_id: 2 },
  { head_repository_id: undefined },
  { id: 201 },
  { head_sha: SHA },
  { head_branch: 'other' },
])('snapshot artifact association rejects%j', async (mutation) => {
  const { deps, context, artifact } = restoredFixture();
  Object.assign(artifact.workflow_run as object, mutation);
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    /Invalid (snapshot .*repository ID|source snapshot association)/
  );
  expect(queriedLatest(deps)).toBe(false);
});
test('metadata authentication and incomplete pages never become initial selection', async () => {
  const { deps, context } = restoredFixture();
  deps.failures.set(
    `${BASE}/actions/runs/200/jobs?filter=all&per_page=100`,
    new Error('Named fake incomplete source job pages')
  );
  await expect(resolveCanarySourceSnapshot(context, deps)).rejects.toThrow(
    'Named fake incomplete source job pages'
  );
  expect(queriedLatest(deps)).toBe(false);
});
test.each([
  { event: 'push' },
  { head_branch: 'other' },
  { workflow_id: 5 },
  { head_sha: SHA },
  { repository: { id: 2, full_name: REPO } },
])('canary execution identity rejects%j', async (mutation) => {
  const deps = new FakeSnapshotDependencies();
  deps.values.set(`${BASE}/actions/runs/200/attempts/1`, {
    status: 200,
    body: { ...canaryRun(1), ...mutation },
  });
  await expect(resolveCanarySourceSnapshot(execution, deps)).rejects.toThrow(
    'Invalid canary execution identity'
  );
  expect(queriedLatest(deps)).toBe(false);
});
test('restored version/channel and selected checkout identity cannot change', async () => {
  const { deps, context } = restoredFixture();
  const resolution = await resolveCanarySourceSnapshot(context, deps);
  const identity = {
    sourceSha: SHA,
    version: VERSION,
    channel: 'canary',
    executionRevision: EXECUTION,
  };
  expect(() =>
    writeCanarySourceSnapshot(resolution, { ...identity, version: '2.0.0-canary.aaaaaaa' })
  ).toThrow('Restored source identity mismatch');
  expect(() => writeCanarySourceSnapshot(resolution, { ...identity, channel: 'latest' })).toThrow(
    'Invalid selected application identity'
  );
  expect(() => writeCanarySourceSnapshot(resolution, { ...identity, sourceSha: NEW_SHA })).toThrow(
    'expected frozen source'
  );
  expect(() =>
    writeCanarySourceSnapshot(resolution, { ...identity, executionRevision: NEW_SHA })
  ).toThrow('original workflow execution revision');
  expect(() =>
    writeCanarySourceSnapshot({ ...resolution, source: { ...selected, runNumber: 101 } }, identity)
  ).toThrow('exact frozen CI selection');
});
test('source writer rejects malformed restoration and unexpected restored data on initial selection', () => {
  const identity = {
    sourceSha: SHA,
    version: VERSION,
    channel: 'canary',
    executionRevision: EXECUTION,
  };
  const resolution: CanarySourceResolution = {
    source: selected,
    executionRevision: EXECUTION,
    restored: true,
  };
  expect(() => writeCanarySourceSnapshot(resolution, identity)).toThrow(
    'expected original snapshot bytes'
  );
  expect(() =>
    writeCanarySourceSnapshot({ ...resolution, restored: false, snapshotRaw: '{}' }, identity)
  ).toThrow('unexpected restored snapshot bytes');
});

const fakeSnapshotGh = `#!/usr/bin/env bun
import{appendFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(process.env.FAKE_TRACE,JSON.stringify(args)+'\\n');const responses=await Bun.file(process.env.FAKE_RESPONSES).json();const response=responses[JSON.stringify(args)];if(!response){console.error('Unexpected fake snapshot gh command');process.exit(99);}process.stdout.write(response);`;
test('CLI resolves before app checkout and writes source.json after identity without extra network reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-snapshot-cli-'));
  try {
    const responses: Record<string, string> = {};
    const response = (path: string, body: unknown) => {
      responses[JSON.stringify(['api', '--include', path])] =
        `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`;
    };
    response(BASE, { id: 1, full_name: REPO });
    response(`${BASE}/actions/workflows/canary.yml`, {
      id: 20,
      path: '.github/workflows/canary.yml',
      state: 'active',
    });
    response(`${BASE}/actions/workflows/ci.yml`, {
      id: 5,
      path: '.github/workflows/ci.yml',
      state: 'active',
    });
    response(`${BASE}/actions/runs/200/attempts/1`, canaryRun(1));
    responses[
      JSON.stringify([
        'api',
        '--paginate',
        '--slurp',
        `${BASE}/actions/runs/200/jobs?filter=all&per_page=100`,
      ])
    ] = JSON.stringify([{ total_count: 1, jobs: [sourceJob(1, 'pending')] }]);
    responses[
      JSON.stringify([
        'api',
        '--paginate',
        '--slurp',
        `${BASE}/actions/workflows/5/runs?branch=main&event=push&status=success&per_page=100`,
      ])
    ] = JSON.stringify([{ total_count: 1, workflow_runs: [ciRun()] }]);
    const responsesPath = join(directory, 'responses.json');
    writeFileSync(responsesPath, JSON.stringify(responses));
    writeFileSync(join(directory, 'gh'), fakeSnapshotGh);
    chmodSync(join(directory, 'gh'), 0o755);
    const trace = join(directory, 'trace');
    const selectionPath = join(directory, 'selection.json');
    const snapshotPath = join(directory, 'snapshot', 'source.json');
    const outputs = join(directory, 'outputs');
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      REPO,
      GITHUB_RUN_ID: '200',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: EXECUTION,
      SELECTION_PATH: selectionPath,
      SNAPSHOT_PATH: snapshotPath,
      GITHUB_OUTPUT: outputs,
      FAKE_TRACE: trace,
      FAKE_RESPONSES: responsesPath,
    };
    const resolved = Bun.spawnSync(['bun', './scripts/ci/freeze-canary-source.ts', 'resolve'], {
      env,
    });
    expect(resolved.stderr.toString()).toBe('');
    expect(resolved.exitCode).toBe(0);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(JSON.parse(readFileSync(selectionPath, 'utf8')).source).toEqual(selected);
    const callsBefore = readFileSync(trace, 'utf8');
    const written = Bun.spawnSync(['bun', './scripts/ci/freeze-canary-source.ts', 'write'], {
      env: { ...env, SOURCE_SHA: SHA, VERSION, CHANNEL: 'canary' },
    });
    expect(written.stderr.toString()).toBe('');
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      source: selected,
      version: VERSION,
      channel: 'canary',
      executionRevision: EXECUTION,
    });
    expect(readFileSync(trace, 'utf8')).toBe(callsBefore);
    expect(readFileSync(outputs, 'utf8')).toContain(`sha=${SHA}`);
    expect(readFileSync(outputs, 'utf8')).toContain(`version=${VERSION}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing named current source job is not permission to query latest CI', async () => {
  const deps = new FakeSnapshotDependencies();
  deps.pages.set(`${BASE}/actions/runs/200/jobs?filter=all&per_page=100|jobs`, []);
  await expect(resolveCanarySourceSnapshot(execution, deps)).rejects.toThrow(
    'expected named source job for current attempt'
  );
  expect(queriedLatest(deps)).toBe(false);
});

test('CLI rejects an extra whitespace-only ZIP member instead of trimming it away', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-approval-acquisition-snapshot-zip-'));
  try {
    const { deps, raw } = restoredFixture();
    const responses: Record<string, string> = {};
    for (const [path, response] of deps.values)
      responses[JSON.stringify(['api', '--include', path])] =
        `HTTP/2.0 ${response.status} Status\r\n\r\n${JSON.stringify(response.body)}`;
    for (const [pageKey, values] of deps.pages) {
      const separator = pageKey.lastIndexOf('|');
      const path = pageKey.slice(0, separator);
      const key = pageKey.slice(separator + 1);
      responses[JSON.stringify(['api', '--paginate', '--slurp', path])] = JSON.stringify([
        { total_count: values.length, [key]: values },
      ]);
    }
    for (const [path, response] of deps.binaries)
      responses[JSON.stringify(['api', '--include', path])] =
        `HTTP/2.0 ${response.status} Status\r\n\r\n${Buffer.from(response.body).toString()}`;
    const responsePath = join(directory, 'responses.json');
    writeFileSync(responsePath, JSON.stringify(responses));
    writeFileSync(join(directory, 'gh'), fakeSnapshotGh);
    chmodSync(join(directory, 'gh'), 0o755);
    writeFileSync(
      join(directory, 'unzip'),
      `#!/usr/bin/env bun\nconst args=process.argv.slice(2);if(args[0]==='-Z1')process.stdout.write('source.json\\n \\n');else if(args[0]==='-p'&&args[2]==='source.json')process.stdout.write(process.env.FAKE_SNAPSHOT_RAW);else process.exit(99);\n`
    );
    chmodSync(join(directory, 'unzip'), 0o755);
    const result = Bun.spawnSync(['bun', './scripts/ci/freeze-canary-source.ts', 'resolve'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        REPO,
        GITHUB_RUN_ID: '200',
        GITHUB_RUN_ATTEMPT: '3',
        GITHUB_SHA: EXECUTION,
        SELECTION_PATH: join(directory, 'selection.json'),
        SNAPSHOT_PATH: join(directory, 'source.json'),
        GITHUB_OUTPUT: join(directory, 'outputs'),
        FAKE_RESPONSES: responsePath,
        FAKE_TRACE: join(directory, 'trace'),
        FAKE_SNAPSHOT_RAW: raw,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('expected sole source.json');
    expect(existsSync(join(directory, 'selection.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restored selection keeps its frozen CI workflow ID when current workflow registration changes', async () => {
  const { deps, context } = restoredFixture();
  deps.values.set(`${BASE}/actions/workflows/ci.yml`, {
    status: 200,
    body: { id: 6, path: '.github/workflows/ci.yml', state: 'active' },
  });
  expect((await resolveCanarySourceSnapshot(context, deps)).source.workflowId).toBe(5);
});
