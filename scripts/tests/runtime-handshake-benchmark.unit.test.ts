import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';

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
class DiscardedHandshakeOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}
class FakeRuntimeRefusingHandshake {
  readonly environment: Record<string, string>;
  constructor(
    private readonly root: string,
    successfulBeforeFailure = 0,
    stall = false
  ) {
    this.environment = {
      BENCHMARK_FIXTURE_ROOT: root,
      BENCHMARK_FIXTURE_SUCCESSFUL_BEFORE_FAILURE: String(successfulBeforeFailure),
      BENCHMARK_FIXTURE_STALL: String(stall),
    };
  }
  async create(): Promise<string> {
    const binary = join(this.root, 'fake-runtime');
    await symlink(join(ROOT, 'node_modules'), join(this.root, 'node_modules'), 'dir');
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { join } from 'node:path';
import { Session } from '@mangostudio/protocol';
import { stdioPort } from '@mangostudio/protocol/stdio';
import { RUNTIME_CONTRACT_NAME, RUNTIME_CONTRACT_VERSION } from '@mangostudio/shared/runtime-contract';
if (process.argv.includes('--version')) { console.log('mangostudio-runtime 0.1.1'); process.exit(0); }
if (process.env.HOME !== process.env.MANGO_HOME || process.env.USERPROFILE !== process.env.MANGO_HOME) throw new Error('Fixture expected isolated matching HOME, USERPROFILE and MANGO_HOME');
const fixtureRoot = process.env.BENCHMARK_FIXTURE_ROOT;
const successfulBeforeFailure = Number(process.env.BENCHMARK_FIXTURE_SUCCESSFUL_BEFORE_FAILURE);
const stall = process.env.BENCHMARK_FIXTURE_STALL === 'true';
const counterPath = join(fixtureRoot, 'counter');
const count = Number(await Bun.file(counterPath).text().catch(() => '0')) + 1;
await Bun.write(counterPath, String(count));
if (count > successfulBeforeFailure && stall) { await Bun.write(join(fixtureRoot, 'stall-reached'), 'later handshake attempt'); console.error('Intentional fixture handshake cancellation'); setInterval(() => {}, 1000); while (!(await Bun.file(join(fixtureRoot, 'cancel-now')).exists())) await Bun.sleep(5); process.kill(process.ppid, 'SIGTERM'); await new Promise(() => {}); }
if (count > successfulBeforeFailure) {
  console.error('Intentional fixture handshake refusal');
  process.exit(3);
}

new Session(stdioPort(), { peer: { name: 'fixture-runtime', version: '0.1.1', role: 'tool' }, capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } }, handlers: { 'runtime.health': () => ({ status: 'ok' }) }, livenessIntervalMs: false });
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}

/** A version probe that requests cancellation and keeps its inherited pipes open. */
class FakeHangingRuntimeVersion {
  constructor(private readonly root: string) {}

  async create(): Promise<string> {
    const binary = join(this.root, 'fake-runtime-version');
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { join } from 'node:path';
const root = process.env.BENCHMARK_FIXTURE_ROOT;
await Bun.write(join(root, 'version-home'), process.env.HOME);
await Bun.write(join(root, 'stall-reached'), String(process.pid));
while (!(await Bun.file(join(root, 'cancel-now')).exists())) await Bun.sleep(5);
const benchmarkPid = Number(await Bun.file(join(root, 'benchmark-pid')).text());
process.kill(benchmarkPid, 'SIGTERM');
while (!(await Bun.file(join(root, 'finish-now')).exists())) await Bun.sleep(5);
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}

/** A protocol-speaking runtime with a descendant retaining stderr and its home. */
class FakeHeldOutputRuntime {
  constructor(private readonly root: string) {}

  async create(): Promise<string> {
    const binary = join(this.root, 'fake-held-output-runtime');
    await symlink(join(ROOT, 'node_modules'), join(this.root, 'node_modules'), 'dir');
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { join } from 'node:path';
import { Session } from '@mangostudio/protocol';
import { stdioPort } from '@mangostudio/protocol/stdio';
import { RUNTIME_CONTRACT_NAME, RUNTIME_CONTRACT_VERSION } from '@mangostudio/shared/runtime-contract';
if (process.argv.includes('--version')) { console.log('mangostudio-runtime 0.1.1'); process.exit(0); }
const root=process.env.BENCHMARK_FIXTURE_ROOT;
await Bun.write(join(root,'runtime-home'),process.env.MANGO_HOME);
Bun.spawn([process.execPath,'-e',"import {join} from 'node:path'; import {rename} from 'node:fs/promises'; const root=process.env.BENCHMARK_FIXTURE_ROOT; await Bun.write(join(root,'leaf-pid-tmp'),String(process.pid)); await rename(join(root,'leaf-pid-tmp'),join(root,'leaf-pid')); while (!(await Bun.file(join(root,'leaf-release')).exists())) await Bun.sleep(5);"],{stdout:'ignore',stderr:'inherit',env:{...process.env,BUN_FEATURE_FLAG_NO_ORPHANS:'0'}});
while (!(await Bun.file(join(root,'allow-ready')).exists())) await Bun.sleep(5);
new Session(stdioPort(), {peer:{name:'fixture-runtime',version:'0.1.1',role:'tool'},capabilities:{contracts:{[RUNTIME_CONTRACT_NAME]:RUNTIME_CONTRACT_VERSION}},handlers:{'runtime.health':()=>({status:'ok'})},livenessIntervalMs:false});
`
    );
    await chmod(binary, 0o755);
    return binary;
  }
}
describe.skipIf(process.platform === 'win32')('protocol startup receipts', () => {
  it('does not accept a handshake or remove its home while an owned descendant survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-held-output-'));
    const binary = await new FakeHeldOutputRuntime(root).create();
    const output = join(root, 'receipt.json');
    const cleanup = new AbortController();
    const pending = runNativeCommand({
      label: 'handshake-held-output',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '1',
        '--warmups',
        '0',
        '--json',
        '--output',
        output,
      ],
      root: ROOT,
      out: root,
      env: fixtureChildEnvironment({ ...process.env, BENCHMARK_FIXTURE_ROOT: root }),
      timeoutSeconds: 15,
      pollIntervalMs: 20,
      settleMs: 500,
      signal: cleanup.signal,
      stream: new DiscardedHandshakeOutput(),
    });
    try {
      const marker = join(root, 'leaf-pid');
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !(await Bun.file(marker).exists())) await Bun.sleep(5);
      expect(await Bun.file(marker).exists()).toBe(true);
      const pid = Number(await Bun.file(marker).text());
      const owned = (await snapshotNativeProcesses()).find((row) => row.pid === pid);
      expect(owned).toBeDefined();
      if (!owned) throw new Error(`expected owned leaf ${pid} | received: absent`);
      escapedFixtures.push(owned);
      const terminal = join(root, 'terminal-handshake-held-output.jsonl');
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
      const home = await Bun.file(join(root, 'runtime-home')).text();
      expect((await stat(home)).isDirectory()).toBe(true);
      await Bun.write(join(root, 'allow-ready'), 'start handshake');
      let receipt: { complete: boolean; attempts: unknown[] } | undefined;
      const receiptDeadline = Date.now() + 8_000;
      while (Date.now() < receiptDeadline) {
        const text = await Bun.file(output)
          .text()
          .catch(() => '');
        try {
          const candidate = JSON.parse(text) as { complete: boolean; attempts: unknown[] };
          if (candidate.attempts.length) {
            receipt = candidate;
            break;
          }
        } catch {
          /* Receipt may not yet be published. */
        }
        await Bun.sleep(5);
      }
      expect(receipt).toBeDefined();
      const survivors = await snapshotNativeProcesses();
      const alive = survivors.some(
        (row) => row.pid === owned.pid && row.identity === owned.identity
      );
      const homeState = await stat(home).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      const homeExists = homeState?.isDirectory() ?? false;
      expect({ alive, homeExists }).not.toEqual({ alive: true, homeExists: false });
      expect({ complete: receipt?.complete, alive, homeExists }).not.toMatchObject({
        complete: true,
        alive: true,
      });
    } finally {
      await Bun.write(join(root, 'leaf-release'), 'release held output');
      cleanup.abort();
      const settled = await Promise.race([pending, Bun.sleep(5_000).then(() => undefined)]);
      if (settled?.settlement.empty && settled.settlement.rootObserved) scratch.push(root);
      expect(settled?.settlement.empty).toBe(true);
      expect(settled?.settlement.rootObserved).toBe(true);
    }
  }, 20_000);

  it('settles the version child when cancellation arrives before benchmark sampling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-version-cancel-'));
    const binary = await new FakeHangingRuntimeVersion(root).create();
    const cleanup = new AbortController();
    const pending = runNativeCommand({
      label: 'version-cancel',
      signal: cleanup.signal,
      command: [process.execPath, 'scripts/bench/runtime-handshake.ts', binary, '--runs', '1'],
      root: ROOT,
      out: root,
      env: fixtureChildEnvironment({ ...process.env, BENCHMARK_FIXTURE_ROOT: root }),
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      settleMs: 500,
      stream: new DiscardedHandshakeOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(root);
    try {
      const owned = await barrier.observe(binary, pending);
      escapedFixtures.push(...owned);
      const rows = await snapshotNativeProcesses();
      const benchmark = rows.find(
        (row) =>
          row.parentPid === process.pid &&
          row.command.includes('scripts/bench/runtime-handshake.ts') &&
          row.command.includes(binary)
      );
      expect(benchmark?.pid).toBeDefined();
      const terminal = Bun.file(join(root, 'terminal-version-cancel.jsonl'));
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const contents = await terminal.text().catch(() => '');
        if (
          contents.includes(owned[0]?.identity ?? 'missing') &&
          contents.includes(benchmark?.identity ?? 'missing')
        )
          break;
        await Bun.sleep(5);
      }
      expect(await terminal.text()).toContain(owned[0]?.identity ?? 'missing identity');
      expect(await terminal.text()).toContain(benchmark?.identity ?? 'missing identity');
      await Bun.write(join(root, 'benchmark-pid'), String(benchmark?.pid));
      await barrier.release();
      const result = await pending;
      escapedFixtures.push(...result.settlement.survivors);
      expect(result.timedOut).toBe(false);
      expect(result.settlement.empty).toBe(true);
    } finally {
      await Bun.write(join(root, 'finish-now'), 'finish controlled fixture');
      cleanup.abort();
      const settled = await Promise.race([pending, Bun.sleep(5_000).then(() => undefined)]);
      if (settled?.settlement.empty && settled.settlement.rootObserved) scratch.push(root);
      expect(settled?.settlement.empty).toBe(true);
      expect(settled?.settlement.rootObserved).toBe(true);
    }
  }, 15_000);

  it('keeps executable source independent of fixture paths and settings', async () => {
    const first = await mkdtemp(join(tmpdir(), 'benchmark-program-first-'));
    const second = await mkdtemp(join(tmpdir(), 'benchmark-program-second-'));
    scratch.push(first, second);
    const a = await new FakeRuntimeRefusingHandshake(first, 0, false).create();
    const b = await new FakeRuntimeRefusingHandshake(second, 3, true).create();
    expect(await Bun.file(a).text()).toBe(await Bun.file(b).text());
  });

  it('preserves completed handshakes when the intended later attempt cancels the benchmark', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'runtime-handshake-cancel-\'"`-' + '${' + 'literal}-')
    );
    scratch.push(root);
    const fixture = new FakeRuntimeRefusingHandshake(root, 3, true);
    const binary = await fixture.create();
    const output = join(root, 'receipt.json');
    const pending = runNativeCommand({
      label: 'handshake-cancel',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
        '--output',
        output,
      ],
      root: ROOT,
      out: root,
      env: fixtureChildEnvironment({ ...process.env, ...fixture.environment }),
      timeoutSeconds: 20,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const barrier = new FakeBenchmarkCancelBarrier(root);
    escapedFixtures.push(...(await barrier.observe(binary, pending)));
    await barrier.release();
    const result = await pending;
    escapedFixtures.push(...result.settlement.survivors);
    expect(await Bun.file(join(root, 'stall-reached')).exists()).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(await Bun.file(`${output}.jsonl`).exists()).toBe(true);
    const events = (await readFile(`${output}.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; phase?: string; status?: string });
    expect(
      events
        .filter((event) => event.kind === 'finished')
        .map(({ phase, status }) => ({ phase, status }))
    ).toEqual([
      { phase: 'warmup', status: 'success' },
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
    expect(progress.attempts).toHaveLength(4);
  }, 30_000);

  it('retains protocol warmups and a successful request before a later failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-batch-test-'));
    scratch.push(root);
    const fixture = new FakeRuntimeRefusingHandshake(root, 3);
    const binary = await fixture.create();
    const result = await runNativeCommand({
      label: 'handshake-batch',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
      ],
      root: ROOT,
      out: root,
      env: fixtureChildEnvironment({ ...process.env, ...fixture.environment }),
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const stdout = await readFile(join(root, 'logs/handshake-batch.stdout.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    const receipt = JSON.parse(stdout) as {
      attempts: Array<{ phase: string; status: string; firstRequestMs: number | null }>;
    };
    expect(receipt.attempts.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: 'warmup', status: 'success' },
      { phase: 'warmup', status: 'success' },
      { phase: 'measured', status: 'success' },
      { phase: 'measured', status: 'failed' },
    ]);
    expect(receipt.attempts[2].firstRequestMs).toBeGreaterThan(0);
  });

  it('retains the failed warmup and stops without silently discarding a broken handshake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-handshake-receipt-test-'));
    scratch.push(root);
    const fixture = new FakeRuntimeRefusingHandshake(root);
    const binary = await fixture.create();
    const result = await runNativeCommand({
      label: 'handshake-receipt',
      command: [
        process.execPath,
        'scripts/bench/runtime-handshake.ts',
        binary,
        '--runs',
        '2',
        '--warmups',
        '2',
        '--json',
      ],
      root: ROOT,
      out: root,
      env: fixtureChildEnvironment({ ...process.env, ...fixture.environment }),
      timeoutSeconds: 8,
      pollIntervalMs: 20,
      stream: new DiscardedHandshakeOutput(),
    });
    const stdout = await readFile(join(root, 'logs/handshake-receipt.stdout.log'), 'utf8');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.settlement.empty).toBe(true);
    expect(stdout).toContain('Intentional fixture handshake refusal');
    const receipt = JSON.parse(stdout) as {
      complete: boolean;
      phasesMs: { hello: unknown };
      attempts: Array<{ phase: string; status: string; firstRequestMs: number | null }>;
    };
    expect(receipt.complete).toBe(false);
    expect(receipt.phasesMs.hello).toBeNull();
    expect(receipt.attempts).toHaveLength(1);
    expect(receipt.attempts[0]).toMatchObject({
      phase: 'warmup',
      status: 'failed',
      firstRequestMs: null,
    });
  });
});
