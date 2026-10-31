import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';

import { ownsStartupState } from '../bench/startup';
import {
  type NativeProcess,
  runNativeCommand,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';
import { FakeBenchmarkCancelBarrier } from './support/benchmark-cancel-barrier';
import { fixtureChildEnvironment } from './support/child-supervision';

const ROOT = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
const escapedFixtures: NativeProcess[] = [];

afterEach(async () => {
  const current = await snapshotNativeProcesses();
  for (const fixture of escapedFixtures.splice(0)) {
    if (current.some((row) => row.pid === fixture.pid && row.identity === fixture.identity))
      process.kill(fixture.pid, 'SIGKILL');
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class DiscardedBenchmarkOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}

/** A local executable which succeeds once after warmup, then rejects its next startup. */
class FakeStartupBinary {
  readonly environment: Record<string, string>;
  constructor(
    private readonly directory: string,
    stall = false
  ) {
    this.environment = {
      BENCHMARK_FIXTURE_ROOT: directory,
      BENCHMARK_FIXTURE_STALL: String(stall),
    };
  }

  async create(): Promise<string> {
    const binary = join(this.directory, 'fake-startup-binary');
    await writeFile(
      binary,
      `#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.HOME;
const fixtureRoot = process.env.BENCHMARK_FIXTURE_ROOT;
const stall = process.env.BENCHMARK_FIXTURE_STALL === 'true';
const counterPath = join(home, 'startup-counter');
const count = Number(await Bun.file(counterPath).text().catch(() => '0')) + 1;
await Bun.write(counterPath, String(count));
if (count === 3 && stall) { await Bun.write(join(fixtureRoot, 'stall-reached'), 'later startup attempt'); console.error('Intentional fixture startup cancellation'); setInterval(() => {}, 1000); while (!(await Bun.file(join(fixtureRoot, 'cancel-now')).exists())) await Bun.sleep(5); process.kill(process.ppid, 'SIGTERM'); await new Promise(() => {}); }
if (count === 3) {
  console.error('Intentional fixture startup failure after one measured success');
  process.exit(3);
}
const port = Number(process.argv.at(-1));
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ status: 'ok' }) });
const stateDir = join(home, '.mango', 'run');
await mkdir(stateDir, { recursive: true });
await Bun.write(join(stateDir, 'server.json'), JSON.stringify({ pid: process.pid, port, host: '127.0.0.1', startedAt: Date.now() }));
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}

/** A hub whose descendant keeps the inherited output open after the hub exits. */
class FakeHeldOutputHub {
  constructor(private readonly root: string) {}

  async create(): Promise<string> {
    const binary = join(this.root, 'fake-held-output-hub');
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.BENCHMARK_FIXTURE_ROOT;
const leaf = Bun.spawn([process.execPath, '-e', "import {join} from 'node:path'; import {rename} from 'node:fs/promises'; const root=process.env.BENCHMARK_FIXTURE_ROOT; await Bun.write(join(root,'leaf-pid-tmp'),String(process.pid)); await rename(join(root,'leaf-pid-tmp'),join(root,'leaf-pid')); while (!(await Bun.file(join(root,'leaf-release')).exists())) await Bun.sleep(5);"], { stdout:'inherit', stderr:'inherit', env:{...process.env,BUN_FEATURE_FLAG_NO_ORPHANS:'0'} });
while (!(await Bun.file(join(root,'allow-ready')).exists())) await Bun.sleep(5);
const port = Number(process.argv.at(-1));
const server = Bun.serve({hostname:'127.0.0.1',port,fetch:()=>Response.json({status:'ok'})});
const stateDir = join(process.env.HOME,'.mango','run');
await mkdir(stateDir,{recursive:true});
await writeFile(join(stateDir,'server.json'),JSON.stringify({pid:process.pid,port,host:'127.0.0.1',startedAt:Date.now()}));
process.on('SIGTERM',()=>{ writeFileSync(join(root,'hub-stopped'),'stopped'); server.stop(true); process.exit(0); });
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}

describe.skipIf(process.platform === 'win32')('startup benchmark receipts', () => {
  it('settles descendants that retain startup output after the hub exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-startup-held-output-'));
    const binary = await new FakeHeldOutputHub(directory).create();
    const cleanup = new AbortController();
    const pending = runNativeCommand({
      label: 'startup-held-output',
      command: [process.execPath, 'scripts/bench/startup.ts', binary, '--runs', '1', '--json'],
      root: ROOT,
      out: directory,
      env: fixtureChildEnvironment({ ...process.env, BENCHMARK_FIXTURE_ROOT: directory }),
      timeoutSeconds: 15,
      pollIntervalMs: 20,
      settleMs: 500,
      signal: cleanup.signal,
      stream: new DiscardedBenchmarkOutput(),
    });
    try {
      const leafMarker = join(directory, 'leaf-pid');
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !(await Bun.file(leafMarker).exists())) await Bun.sleep(5);
      expect(await Bun.file(leafMarker).exists()).toBe(true);
      const pid = Number(await Bun.file(leafMarker).text());
      const owned = (await snapshotNativeProcesses()).find((row) => row.pid === pid);
      expect(owned, `expected live leaf pid ${pid} | received: absent`).toBeDefined();
      if (!owned) throw new Error(`expected owned leaf ${pid} | received: absent`);
      escapedFixtures.push(owned);
      const terminal = join(directory, 'terminal-startup-held-output.jsonl');
      while (
        Date.now() < deadline &&
        !(
          await Bun.file(terminal)
            .text()
            .catch(() => '')
        ).includes(owned.identity)
      )
        await Bun.sleep(5);
      expect(await Bun.file(terminal).text()).toContain(owned.identity);
      await Bun.write(join(directory, 'allow-ready'), 'start readiness');
      const stopMarker = Bun.file(join(directory, 'hub-stopped'));
      const stopDeadline = Date.now() + 4_000;
      while (Date.now() < stopDeadline && !(await stopMarker.exists())) await Bun.sleep(5);
      expect(await stopMarker.exists()).toBe(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        pending.then((result) => ({ result })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 6_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!first) await Bun.write(join(directory, 'leaf-release'), 'release held output');
      const result = first?.result ?? (await pending);
      escapedFixtures.push(...result.settlement.survivors);
      expect(result.timedOut).toBe(false);
      expect(first).not.toBeNull();
      expect(result.settlement.empty).toBe(true);
    } finally {
      await Bun.write(join(directory, 'leaf-release'), 'release held output');
      cleanup.abort();
      const settled = await Promise.race([pending, Bun.sleep(5_000).then(() => undefined)]);
      if (settled?.settlement.empty && settled.settlement.rootObserved) scratch.push(directory);
      expect(settled?.settlement.empty).toBe(true);
      expect(settled?.settlement.rootObserved).toBe(true);
    }
  }, 20_000);

  it('keeps executable source independent of fixture paths and settings', async () => {
    const first = await mkdtemp(join(tmpdir(), 'benchmark-program-first-'));
    const second = await mkdtemp(join(tmpdir(), 'benchmark-program-second-'));
    scratch.push(first, second);
    const a = await new FakeStartupBinary(first, false).create();
    const b = await new FakeStartupBinary(second, true).create();
    expect(await Bun.file(a).text()).toBe(await Bun.file(b).text());
  });

  it('preserves finished samples when the intended later attempt cancels the benchmark', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mango-startup-cancel-\'"`-' + '${' + 'literal}-')
    );
    scratch.push(directory);
    const fixture = new FakeStartupBinary(directory, true);
    const binary = await fixture.create();
    const output = join(directory, 'receipt.json');
    const journal = `${output}.jsonl`;
    const pending = runNativeCommand({
      label: 'startup-cancel',
      command: [
        process.execPath,
        'scripts/bench/startup.ts',
        binary,
        '--warm',
        '--runs',
        '2',
        '--json',
        '--output',
        output,
      ],
      root: ROOT,
      out: directory,
      env: fixtureChildEnvironment({ ...process.env, ...fixture.environment }),
      timeoutSeconds: 20,
      pollIntervalMs: 20,
      stream: new DiscardedBenchmarkOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(directory);
    escapedFixtures.push(...(await barrier.observe(binary, pending)));
    await barrier.release();
    const result = await pending;
    escapedFixtures.push(...result.settlement.survivors);
    expect(await Bun.file(join(directory, 'stall-reached')).exists()).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(await Bun.file(journal).exists()).toBe(true);
    const events = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; phase?: string; status?: string });
    expect(
      events
        .filter((event) => event.kind === 'finished')
        .map(({ phase, status }) => ({ phase, status }))
    ).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'finished', phase: 'measured', status: 'failed' });
    const progress = JSON.parse(await readFile(output, 'utf8')) as {
      complete: boolean;
      attempts: unknown[];
    };
    expect(progress.complete).toBe(false);
    expect(progress.attempts).toHaveLength(3);
  }, 30_000);

  it('retains warmup, successful and failed attempts when a later startup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mango-startup-receipt-test-'));
    scratch.push(directory);
    const fixture = new FakeStartupBinary(directory);
    const binary = await fixture.create();
    const result = await runNativeCommand({
      label: 'startup-receipt',
      command: [
        process.execPath,
        'scripts/bench/startup.ts',
        binary,
        '--warm',
        '--runs',
        '2',
        '--json',
      ],
      root: ROOT,
      out: directory,
      env: fixtureChildEnvironment({ ...process.env, ...fixture.environment }),
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedBenchmarkOutput(),
    });
    const stdout = await readFile(join(directory, 'logs/startup-receipt.stdout.log'), 'utf8');
    const stderr = await readFile(join(directory, 'logs/startup-receipt.stderr.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(`${stdout}\n${stderr}`).toContain(
      'Intentional fixture startup failure after one measured success'
    );
    expect(stdout).toContain('"attempts"');
    const receipt = JSON.parse(stdout) as { attempts: Array<{ phase: string; status: string }> };
    expect(receipt.attempts.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
  });
});

describe('startup child identity', () => {
  it('requires the current pid, bound port and a fresh isolated state record', () => {
    const state = { pid: 42, port: 3001, startedAt: 100 };
    expect(ownsStartupState(state, 42, 3001, 99)).toBe(true);
    expect(ownsStartupState(state, 43, 3001, 99)).toBe(false);
    expect(ownsStartupState(state, 42, 3002, 99)).toBe(false);
    expect(ownsStartupState(state, 42, 3001, 101)).toBe(false);
    expect(ownsStartupState(null, 42, 3001, 99)).toBe(false);
    expect(ownsStartupState({ ...state, startedAt: '100' }, 42, 3001, 99)).toBe(false);
    expect(ownsStartupState({ ...state, startedAt: Number.POSITIVE_INFINITY }, 42, 3001, 99)).toBe(
      false
    );
  });
});
