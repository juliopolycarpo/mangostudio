import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CommandSample, CommandSpec } from '../bench/cargo-feature-measurement';
import {
  allowedLogs,
  archiveLogs,
  assertFixture,
  assertTaskResults,
  boundPayload,
  COMMENT_PATH,
  cacheFiles,
  compareSnapshots,
  digest,
  finishSnapshot,
  type HostedCache,
  type HostedJob,
  hostedCaches,
  hostedJobs,
  hostSnapshotIo,
  MAX_PAYLOAD_BYTES,
  type PayloadEntry,
  type Phase,
  readTurboSummary,
  realTasks,
  SNAPSHOT_SOURCE,
  type SnapshotIo,
  type SnapshotOptions,
  type SnapshotReceipt,
  SOURCE_COMMENT,
  snapshotCommand,
  snapshotJson,
  snapshotKeys,
  snapshotMain,
  snapshotOptions,
  TASK_LOGS,
  type TurboSummary,
  type Variant,
  verifySourceForPreparation,
} from '../bench/turbo-snapshot-measurement';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mango-snapshot-test-'));
  temporary.push(path);
  return path;
}

function options(phase: Phase = 'prime', variant: Variant = 'baseline'): SnapshotOptions {
  return {
    phase,
    variant,
    source: '/fixture/source',
    output: '/fixture/receipts',
    runId: '123',
    attempt: '1',
  };
}

function summary(changed = false, hit = false): TurboSummary {
  return {
    turboVersion: '2.11.6',
    globalCacheInputs: { identity: 'held-constant' },
    tasks: Object.keys(TASK_LOGS).map((taskId, index) => ({
      taskId,
      command: 'tsc --noEmit',
      hash: `${changed ? 'b' : 'a'}${String(index).padStart(15, '0')}`,
      cache: { status: hit ? 'HIT' : 'MISS', local: hit, remote: false },
      execution: { exitCode: 0, startTime: 100, endTime: 104 },
    })),
  };
}

class SnapshotFake implements SnapshotIo {
  storage = new Map<string, string>();
  specs: CommandSpec[] = [];
  outputs: Record<string, string>[] = [];
  failLabel = '';
  cancelLabel = '';
  wrongHead = false;
  mutateDuringCompiler = false;
  constructor(readonly options: SnapshotOptions) {
    this.storage.set(join(options.source, COMMENT_PATH), 'export {};\n');
  }
  read(path: string): string {
    return this.storage.get(path) ?? 'fixed configuration bytes';
  }
  summary(source: string): string {
    return this.read(join(source, '.turbo/runs/generated.json'));
  }
  archive(path: string): Promise<string[]> {
    return Promise.resolve([this.read(path)]);
  }
  write(path: string, content: string): void {
    this.storage.set(path, content);
  }
  output(values: Record<string, string>): void {
    this.outputs.push(values);
  }
  files(path: string): PayloadEntry[] {
    return [...this.storage.entries()]
      .filter(([file]) => file.startsWith(`${path}/`))
      .map(([file, bytes]) => ({
        name: basename(file),
        bytes: Buffer.byteLength(bytes),
        sha256: digest(bytes),
        regular: true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  cache(summaryValue: TurboSummary): void {
    const cache = join(this.options.source, '.mango/turbo-snapshot');
    for (const task of realTasks(summaryValue)) {
      const log = TASK_LOGS[task.taskId as keyof typeof TASK_LOGS];
      this.write(join(cache, `${task.hash}.tar.zst`), log);
      this.write(
        join(cache, `${task.hash}-meta.json`),
        JSON.stringify({ hash: task.hash, sha: SNAPSHOT_SOURCE })
      );
      this.write(
        join(cache, `${task.hash}-manifest.json`),
        JSON.stringify({ files: { [log]: { is_dir: false } }, order: [log] })
      );
    }
  }
  run(spec: CommandSpec): Promise<CommandSample> {
    this.specs.push(spec);
    const changed = this.read(join(this.options.source, COMMENT_PATH)).endsWith(SOURCE_COMMENT);
    let stdout = '';
    if (spec.argv[0] === 'git' && spec.argv[1] === 'rev-parse')
      stdout = this.wrongHead ? 'bad-head\n' : `${SNAPSHOT_SOURCE}\n`;
    if (spec.argv[0] === 'git' && spec.argv[1] === 'status')
      stdout = changed ? ` M ${COMMENT_PATH}\n` : '';
    if (spec.argv[0] === 'git' && spec.argv[1] === 'show') stdout = 'export {};\n';
    if (spec.label === 'bun-version') stdout = '1.4.2\n';
    if (spec.label === 'turbo-version') stdout = '2.11.6\n';
    if (spec.label === 'typescript-version') stdout = 'Version 7.0.2\n';
    if (spec.label.endsWith('-dry')) stdout = JSON.stringify(summary(changed));
    if (spec.label === 'real-typechecks') {
      const value = summary(
        changed,
        this.options.phase === 'replay' && this.options.variant === 'candidate'
      );
      this.write(join(this.options.source, '.turbo/runs/generated.json'), JSON.stringify(value));
      this.cache(value);
      if (this.mutateDuringCompiler)
        this.write(join(this.options.source, COMMENT_PATH), 'unexpected mutation');
    }
    return Promise.resolve({
      ...spec,
      startedUtc: '2026-10-06T01:00:00Z',
      endedUtc: '2026-10-06T01:00:00.002Z',
      wallMs: 2,
      exitCode: spec.label === this.failLabel ? 23 : 0,
      canceled: spec.label === this.cancelLabel,
      timedOut: false,
      signal: null,
      resourceUsage: null,
      stdout,
      stderr: '',
    });
  }
}

function actions(receipt: SnapshotReceipt): Record<string, string> {
  const { phase, variant } = receipt.options;
  return {
    prepare: 'success',
    restore: 'success',
    measure: 'success',
    cap: 'success',
    save: phase === 'replay' ? 'skipped' : 'success',
    hit: phase === 'prime' ? '' : variant === 'candidate' && phase === 'change' ? 'false' : 'true',
    matched:
      phase === 'prime'
        ? ''
        : variant === 'candidate' && phase === 'replay'
          ? receipt.keys.k1
          : receipt.keys.k0,
  };
}

async function caseReceipt(
  phase: Phase,
  variant: Variant,
  saved?: SnapshotFake
): Promise<{ receipt: SnapshotReceipt; fake: SnapshotFake }> {
  const opts = options(phase, variant);
  const fake = new SnapshotFake(opts);
  await snapshotCommand('prepare', opts, fake);
  if (saved)
    for (const [path, bytes] of saved.storage)
      if (path.includes('/.mango/turbo-snapshot/')) fake.write(path, bytes);
  await snapshotCommand('measure', opts, fake);
  const receipt = await snapshotCommand('cap', opts, fake);
  finishSnapshot(receipt, actions(receipt));
  return { receipt, fake };
}

function hostedJob(receipt: SnapshotReceipt): HostedJob {
  return {
    name: `Turbo snapshot (${receipt.options.phase} / ${receipt.options.variant})`,
    conclusion: 'success',
    started_at: '2026-10-06T01:00:00Z',
    completed_at: '2026-10-06T01:01:00Z',
    steps: ['Restore private snapshot', 'Save bounded private snapshot'].map((name) => ({
      name,
      conclusion:
        name.startsWith('Save') && receipt.options.phase === 'replay' ? 'skipped' : 'success',
      started_at: '2026-10-06T01:00:10Z',
      completed_at: '2026-10-06T01:00:11Z',
    })),
  };
}

async function matrix(): Promise<SnapshotReceipt[]> {
  const receipts: SnapshotReceipt[] = [];
  for (const variant of ['baseline', 'candidate'] as const) {
    const prime = await caseReceipt('prime', variant);
    const changed = await caseReceipt('change', variant, prime.fake);
    const replay = await caseReceipt(
      'replay',
      variant,
      variant === 'baseline' ? prime.fake : changed.fake
    );
    receipts.push(prime.receipt, changed.receipt, replay.receipt);
  }
  return receipts;
}

class JobsApiFake {
  urls: string[] = [];
  status = 200;
  invalidBody = false;
  jobs: HostedJob[] = [];
  caches: HostedCache[] = [];
  request(url: string | URL | Request): Promise<Response> {
    this.urls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    const key = new URL(String(url)).searchParams.get('key');
    const rows = this.caches.filter((cache) => cache.key.startsWith(key ?? ''));
    const body =
      key === null
        ? { jobs: this.jobs.slice((page - 1) * 100, page * 100) }
        : { actions_caches: rows.slice((page - 1) * 100, page * 100) };
    return Promise.resolve(
      Response.json(this.invalidBody ? { wrong: [] } : body, { status: this.status })
    );
  }
  fetch(): typeof fetch {
    return this.request.bind(this) as typeof fetch;
  }
}

function hostedCacheRows(receipts: SnapshotReceipt[]): HostedCache[] {
  return receipts
    .filter(
      (receipt) =>
        receipt.options.phase === 'prime' ||
        (receipt.options.phase === 'change' && receipt.options.variant === 'candidate')
    )
    .map((receipt, index) => ({
      id: index + 1,
      key: receipt.keys.save,
      ref: 'refs/heads/measure/turbo-snapshot-cache',
      version: 'same-private-path-version',
      size_in_bytes: 1024,
      created_at: '2026-10-06T01:00:00Z',
      last_accessed_at: '2026-10-06T01:00:01Z',
    }));
}

const API_ENV = {
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_TOKEN: 'named-fake-token',
};

describe('hosted Turbo snapshot receipts', () => {
  test('pins options, exact comment bytes and separate per-arm keys', () => {
    expect(
      snapshotOptions({ ...API_ENV, SNAPSHOT_PHASE: 'change', SNAPSHOT_VARIANT: 'candidate' }).phase
    ).toBe('change');
    expect(() =>
      snapshotOptions({ ...API_ENV, SNAPSHOT_PHASE: 'bad', SNAPSHOT_VARIANT: 'candidate' })
    ).toThrow('expected prime|change|replay');
    expect(() =>
      snapshotOptions({
        ...API_ENV,
        GITHUB_RUN_ID: 'bad',
        SNAPSHOT_PHASE: 'prime',
        SNAPSHOT_VARIANT: 'baseline',
      })
    ).toThrow('decimal hosted identities');
    const baseline = snapshotKeys(options('change'), { config: 'abc' });
    const candidate = snapshotKeys(options('change', 'candidate'), { config: 'abc' });
    expect(candidate.prefix).not.toBe(baseline.prefix);
    expect(baseline.restore).toBe(baseline.k0);
    expect(baseline.restorePrefix).toBe('');
    expect(candidate.restore).toBe(candidate.k1);
    expect(candidate.restorePrefix).toBe(candidate.prefix);
    expect(
      snapshotKeys(options('prime', 'candidate'), { config: 'abc' }).restore.endsWith('K0')
    ).toBe(true);
    expect(snapshotKeys({ ...options(), attempt: '2' }, { config: 'abc' }).prefix).not.toBe(
      baseline.prefix
    );
    assertFixture(SNAPSHOT_SOURCE, '', 'base', 'base', 'prime');
    assertFixture(SNAPSHOT_SOURCE, ` M ${COMMENT_PATH}`, 'base', `base${SOURCE_COMMENT}`, 'replay');
    expect(() =>
      assertFixture(SNAPSHOT_SOURCE, ` M ${COMMENT_PATH}`, 'base', 'base// other', 'change')
    ).toThrow('exact');
    expect(() => assertFixture('wrong', '', 'base', 'base', 'prime')).toThrow('expected');
    expect(() => assertFixture(SNAPSHOT_SOURCE, ' M bun.lock', 'base', 'base', 'prime')).toThrow(
      'expected'
    );
    expect(digest(SOURCE_COMMENT)).toHaveLength(64);
  });

  test('accepts the exact real task coverage and rejects changed commands, duplicates and unknown virtual tasks', () => {
    const value = summary();
    expect(realTasks(value)).toHaveLength(4);
    for (const changed of [
      { ...value, turboVersion: 'wrong' },
      { ...value, tasks: value.tasks.slice(1) },
      { ...value, tasks: [...value.tasks, value.tasks[0]] },
      {
        ...value,
        tasks: value.tasks.map((task) => ({ ...task, command: 'tsc --noEmit --incremental' })),
      },
      {
        ...value,
        tasks: [...value.tasks, { ...value.tasks[0], taskId: 'foreign', command: '<NONEXISTENT>' }],
      },
    ])
      expect(() => realTasks(changed)).toThrow('expected');
    expect(
      realTasks({
        ...value,
        tasks: [
          ...value.tasks,
          { ...value.tasks[0], taskId: 'mangostudio#typecheck', command: '<NONEXISTENT>' },
        ],
      })
    ).toHaveLength(4);
  });

  test('native resource getters are explicitly unavailable on the persisted wire', () => {
    class NativeAccountingFake {
      get cpuTime(): { user: bigint; system: bigint } {
        return { user: 42n, system: 2n };
      }
      get maxRSS(): number {
        return 1024;
      }
    }
    expect(
      JSON.parse(snapshotJson({ resourceUsage: new NativeAccountingFake(), wallMs: 2 }))
    ).toEqual({ resourceUsage: null, wallMs: 2 });
  });

  test('pinned real Turbo generates one native summary and exposes the assumed local HIT schema with named fake compilers', async () => {
    const dir = directory();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n**/.turbo/\ncache/\nreceipt-output/\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'snapshot-format-fixture',
        private: true,
        packageManager: 'bun@1.4.2',
        workspaces: ['apps/*', 'packages/*'],
      })
    );
    writeFileSync(
      join(dir, 'turbo.json'),
      JSON.stringify({ tasks: { typecheck: { outputs: [] } } })
    );
    for (const [taskId, log] of Object.entries(TASK_LOGS)) {
      const workspace = join(dir, log.split('/.turbo/')[0]);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({
          name: taskId.split('#')[0],
          version: '0.0.0',
          scripts: { typecheck: 'tsc --noEmit' },
        })
      );
    }
    const bin = join(dir, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'tsc'),
      "#!/usr/bin/env bun\nconsole.log('named fake compiler args: ' + Bun.argv.slice(2).join(' '));\n",
      { mode: 0o755 }
    );
    const io = hostSnapshotIo(
      { ...options(), output: join(dir, 'receipt-output') },
      new AbortController().signal
    );
    const install = await io.run({
      label: 'fixture-lock-only',
      argv: ['bun', 'install', '--lockfile-only', '--ignore-scripts'],
      cwd: dir,
      env: {},
      timeoutMs: 1000,
    });
    expect(install.exitCode).toBe(0);
    const turbo = join(import.meta.dir, '../../node_modules/.bin/turbo');
    for (const hit of [false, true]) {
      rmSync(join(dir, '.turbo/runs'), { recursive: true, force: true });
      const sample = await io.run({
        label: hit ? 'named-turbo-hit' : 'named-turbo-miss',
        argv: [
          turbo,
          'run',
          'typecheck',
          '--cache=local:rw',
          `--cache-dir=${join(dir, 'cache')}`,
          '--summarize',
        ],
        cwd: dir,
        env: { TURBO_TELEMETRY_DISABLED: '1' },
        timeoutMs: 1000,
      });
      expect(sample.exitCode).toBe(0);
      const actual = JSON.parse(readTurboSummary(dir)) as TurboSummary;
      expect(realTasks(actual)).toHaveLength(4);
      for (const task of realTasks(actual)) {
        expect(task.cache).toMatchObject({
          status: hit ? 'HIT' : 'MISS',
          local: hit,
          remote: false,
        });
        expect(task.execution?.exitCode).toBe(0);
        if (hit) continue;
        expect(await archiveLogs(join(dir, 'cache', `${task.hash}.tar.zst`))).toEqual([
          TASK_LOGS[task.taskId as keyof typeof TASK_LOGS],
        ]);
      }
      expect(
        boundPayload(
          cacheFiles(join(dir, 'cache')),
          Object.fromEntries(
            realTasks(actual).map((task) => [
              task.hash,
              TASK_LOGS[task.taskId as keyof typeof TASK_LOGS],
            ])
          )
        ).conservativeArchiveBytes
      ).toBeLessThan(MAX_PAYLOAD_BYTES);
    }
    expect(() => readTurboSummary(join(dir, 'missing'))).toThrow('count 0');
    writeFileSync(join(dir, '.turbo/runs/extra.json'), '{}');
    expect(() => readTurboSummary(dir)).toThrow('count 2');
  });

  test('runs all phases through named host fakes and proves stale K0 versus persisted K1', async () => {
    const receipts = await matrix();
    expect(
      receipts.every((receipt) => receipt.status === 'incomplete' && receipt.localComplete)
    ).toBe(true);
    const comparison = compareSnapshots(receipts, receipts.map(hostedJob));
    expect(comparison.status).toBe('complete');
    expect(comparison.timings).toHaveLength(6);
    expect(comparison.errors).toEqual([]);
    expect(receipts[2].summary?.tasks.every((task) => task.cache.status === 'MISS')).toBe(true);
    expect(receipts[5].summary?.tasks.every((task) => task.cache.status === 'HIT')).toBe(true);
    expect(receipts[2].restored).toEqual(receipts[0].payload?.files);
    expect(receipts[5].restored).toEqual(receipts[4].payload?.files);
    expect(receipts[4].payload?.conservativeArchiveBytes).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  test('keeps failed, canceled, missing and inconsistent task/outer-key evidence incomplete', async () => {
    const valid = await matrix();
    for (const changed of [
      { ...valid[0], actions: undefined, localComplete: false },
      { ...valid[0], identity: { changed: 'lock' } },
      { ...valid[2], restored: [] },
    ])
      expect(compareSnapshots([changed, ...valid.slice(1)], valid.map(hostedJob)).status).toBe(
        'incomplete'
      );
    expect(compareSnapshots(valid.slice(1), valid.map(hostedJob)).status).toBe('incomplete');
    const drift = structuredClone(valid);
    (drift[4].fixture as TurboSummary).tasks[0].hash = 'cccccccccccccccc';
    (drift[4].summary as TurboSummary).tasks[0].hash = 'cccccccccccccccc';
    expect(compareSnapshots(drift, valid.map(hostedJob)).errors.join('\n')).toContain('Hash drift');
    const missingActionTiming = valid.map(hostedJob);
    missingActionTiming[0].steps[0].completed_at = null;
    expect(compareSnapshots(valid, missingActionTiming).errors.join('\n')).toContain(
      'Incomplete cache action timings'
    );
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      const jobs = valid.map(hostedJob);
      jobs[0].conclusion = conclusion;
      expect(compareSnapshots(valid, jobs).status).toBe('incomplete');
    }
    const outcomeOverrides: Record<string, string>[] = [
      { measure: 'failure' },
      { cap: 'cancelled' },
      { save: 'skipped' },
      { matched: 'foreign-key' },
    ];
    for (const overrides of outcomeOverrides) {
      const receipt = structuredClone(valid[1]);
      expect(finishSnapshot(receipt, { ...actions(receipt), ...overrides }).localComplete).toBe(
        false
      );
      expect(receipt.status).toBe('incomplete');
    }
    for (const altered of [
      { ...valid[1], sample: { ...(valid[1].sample as CommandSample), canceled: true } },
      { ...valid[1], summary: summary(true, true) },
      { ...valid[1], summary: summary(false) },
      {
        ...valid[1],
        summary: {
          ...summary(true),
          tasks: summary(true).tasks.map((task) => ({
            ...task,
            cache: { ...task.cache, remote: true },
          })),
        },
      },
    ])
      expect(() => assertTaskResults(altered)).toThrow('expected');
  });

  test('stages expected failures and rejects source mutation, foreign or oversized cache entries', async () => {
    for (const label of ['frozen-install', 'real-typechecks']) {
      const fake = new SnapshotFake(options());
      fake.failLabel = label;
      if (label === 'real-typechecks') await snapshotCommand('prepare', fake.options, fake);
      await expect(
        snapshotCommand(label === 'real-typechecks' ? 'measure' : 'prepare', fake.options, fake)
      ).rejects.toThrow('exit 0');
      expect(JSON.parse(fake.read(join(fake.options.output, 'receipt.json'))).status).toBe(
        'incomplete'
      );
    }
    const fake = new SnapshotFake(options());
    await snapshotCommand('prepare', fake.options, fake);
    fake.cancelLabel = 'real-typechecks';
    await expect(snapshotCommand('measure', fake.options, fake)).rejects.toThrow('cancellation');
    fake.cancelLabel = '';
    fake.mutateDuringCompiler = true;
    await expect(snapshotCommand('measure', fake.options, fake)).rejects.toThrow('exact');
    const wrong = new SnapshotFake(options());
    wrong.wrongHead = true;
    await expect(
      verifySourceForPreparation(wrong.options, wrong, async (_label, argv) =>
        wrong.run({ label: 'source', argv, cwd: wrong.options.source, env: {}, timeoutMs: 100 })
      )
    ).rejects.toThrow('expected');
    const good = await caseReceipt('prime', 'baseline');
    const allowed = allowedLogs(good.receipt);
    const files = good.receipt.payload?.files as PayloadEntry[];
    expect(() => boundPayload([], allowed)).toThrow('empty');
    expect(() => boundPayload([{ ...files[0], name: 'node_modules' }], allowed)).toThrow(
      'known typecheck'
    );
    expect(() => boundPayload([{ ...files[0], regular: false }], allowed)).toThrow('regular');
    expect(() => boundPayload(files.slice(1), allowed)).toThrow('archive, metadata and manifest');
    expect(() =>
      boundPayload(
        files.map((file) => ({ ...file, bytes: MAX_PAYLOAD_BYTES })),
        allowed
      )
    ).toThrow('at most');
    const hash = realTasks(good.receipt.fixture as TurboSummary)[0].hash;
    good.fake.write(
      join(good.fake.options.source, `.mango/turbo-snapshot/${hash}-manifest.json`),
      JSON.stringify({
        files: { 'node_modules/leak': { is_dir: false } },
        order: ['node_modules/leak'],
      })
    );
    await expect(snapshotCommand('cap', good.fake.options, good.fake)).rejects.toThrow(
      'expected only'
    );
    await expect(
      snapshotCommand('invalid', options(), new SnapshotFake(options()))
    ).rejects.toThrow('prepare, measure or cap');
  });

  test('host file reader rejects symlinks and host adapter retains raw named subprocess output', async () => {
    const dir = directory();
    const source = join(dir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'regular'), 'known');
    symlinkSync('regular', join(source, 'link'));
    expect(cacheFiles(join(dir, 'absent'))).toEqual([]);
    expect(cacheFiles(source).map((entry) => [entry.name, entry.regular])).toEqual([
      ['link', false],
      ['regular', true],
    ]);
    const opts = { ...options(), output: join(dir, 'output') };
    const io = hostSnapshotIo(opts, new AbortController().signal);
    const invalidArchive = join(dir, 'invalid.zst');
    writeFileSync(invalidArchive, 'invalid compressed archive');
    await expect(io.archive(invalidArchive)).rejects.toThrow();
    const namedProducer = join(dir, 'named-receipt-producer.ts');
    writeFileSync(namedProducer, "console.log('named producer receipt');\n");
    const sample = await io.run({
      label: 'named-producer',
      argv: ['bun', namedProducer],
      cwd: dir,
      env: {},
      timeoutMs: 1000,
    });
    expect(sample.exitCode).toBe(0);
    expect(sample.stdout).toContain('named producer receipt');
    io.write(join(opts.output, 'extra.json'), '{"retained":true}');
    expect(io.read(join(opts.output, 'extra.json'))).toBe('{"retained":true}');
    expect(readFileSync(join(opts.output, 'named-producer.output.jsonl'), 'utf8')).toContain(
      'named producer receipt'
    );
    io.output({ bounded: 'true' });
  });

  test('read-only API pagination retains exact run attempt and rejects HTTP/malformed/missing identities', async () => {
    const api = new JobsApiFake();
    const value = (await matrix())[0];
    api.jobs = Array.from({ length: 101 }, () => hostedJob(value));
    expect(await hostedJobs(API_ENV, api.fetch())).toHaveLength(101);
    expect(api.urls).toHaveLength(2);
    expect(api.urls[0]).toContain('/runs/123/attempts/1/jobs');
    api.status = 403;
    await expect(hostedJobs(API_ENV, api.fetch())).rejects.toThrow('HTTP 403');
    api.status = 200;
    api.invalidBody = true;
    await expect(hostedJobs(API_ENV, api.fetch())).rejects.toThrow('jobs array');
    await expect(hostedJobs({ ...API_ENV, GITHUB_TOKEN: '' }, api.fetch())).rejects.toThrow(
      'read-only token'
    );
  });

  test('read-only cache inventory qualifies only the three bounded private server identities', async () => {
    const receipts = await matrix();
    const api = new JobsApiFake();
    api.caches = hostedCacheRows(receipts);
    expect(await hostedCaches(API_ENV, receipts, api.fetch())).toHaveLength(3);
    expect(api.urls).toHaveLength(2);
    expect(api.urls.every((url) => new URL(url).pathname.endsWith('/actions/caches'))).toBe(true);
    for (const changed of [
      { size_in_bytes: MAX_PAYLOAD_BYTES + 1 },
      { ref: 'refs/heads/main' },
      { version: 'other-version' },
    ]) {
      api.caches = hostedCacheRows(receipts);
      Object.assign(api.caches[0], changed);
      await expect(hostedCaches(API_ENV, receipts, api.fetch())).rejects.toThrow(
        'exactly three private keys'
      );
    }
    api.caches = hostedCacheRows(receipts).slice(1);
    await expect(hostedCaches(API_ENV, receipts, api.fetch())).rejects.toThrow('exactly three');
    api.status = 403;
    await expect(hostedCaches(API_ENV, receipts, api.fetch())).rejects.toThrow('HTTP 403');
    api.status = 200;
    api.invalidBody = true;
    await expect(hostedCaches(API_ENV, receipts, api.fetch())).rejects.toThrow(
      'actions_caches array'
    );
    await expect(hostedCaches(API_ENV, [], api.fetch())).rejects.toThrow('two K0 keys');
  });

  test('CLI collection/finish stages complete or incomplete evidence without a compiler/service', async () => {
    const dir = directory();
    const input = join(dir, 'collected');
    mkdirSync(input);
    const receipts = await matrix();
    const api = new JobsApiFake();
    api.jobs = receipts.map(hostedJob);
    api.caches = hostedCacheRows(receipts);
    for (const [index, receipt] of receipts.entries()) {
      const folder = join(input, String(index));
      mkdirSync(folder);
      writeFileSync(join(folder, 'receipt.json'), JSON.stringify(receipt));
    }
    const env = { ...API_ENV, SNAPSHOT_INPUT: input, SNAPSHOT_OUTPUT: join(dir, 'summary') };
    await snapshotMain(['collect'], env, api.fetch());
    expect(
      JSON.parse(readFileSync(join(env.SNAPSHOT_OUTPUT, 'comparison.json'), 'utf8')).status
    ).toBe('complete');
    api.jobs[0].conclusion = 'cancelled';
    await expect(snapshotMain(['collect'], env, api.fetch())).rejects.toThrow('Incomplete');
    expect(
      JSON.parse(readFileSync(join(env.SNAPSHOT_OUTPUT, 'comparison.json'), 'utf8')).status
    ).toBe('incomplete');
    const finishEnv = {
      ...API_ENV,
      SNAPSHOT_PHASE: 'prime',
      SNAPSHOT_VARIANT: 'baseline',
      SNAPSHOT_OUTPUT: dir,
      ...Object.fromEntries(
        Object.entries(actions(receipts[0])).map(([key, value]) => [
          `SNAPSHOT_${key.toUpperCase()}`,
          value,
        ])
      ),
    };
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipts[0]));
    await snapshotMain(['finish'], finishEnv);
    expect(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')).localComplete).toBe(true);
    await expect(
      snapshotMain(['finish'], { ...finishEnv, SNAPSHOT_CAP: 'cancelled' })
    ).rejects.toThrow('Invalid action outcomes');
    await expect(
      snapshotMain(['invalid'], {
        ...API_ENV,
        SNAPSHOT_PHASE: 'prime',
        SNAPSHOT_VARIANT: 'baseline',
        SNAPSHOT_OUTPUT: dir,
      })
    ).rejects.toThrow('prepare, measure or cap');
  });
});
