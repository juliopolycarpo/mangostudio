import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { nativeQualificationEnvironment } from '../lib/native-bun-qualification';
import {
  type NativeProcess,
  runNativeCommand,
  snapshotNativeProcesses,
} from '../lib/native-bun-qualification-process';
import { FakeBenchmarkCancelBarrier } from './support/benchmark-cancel-barrier';

const ROOT = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
const owned: NativeProcess[] = [];
const targets: Array<{ path: string; owner: string }> = [];
afterEach(async () => {
  const current = await snapshotNativeProcesses();
  for (const fixture of owned.splice(0))
    if (current.some((row) => row.pid === fixture.pid && row.identity === fixture.identity))
      process.kill(fixture.pid, 'SIGKILL');
  for (const owner of scratch) {
    const receiptFile = Bun.file(join(owner, 'study/receipt.json'));
    if (!(await receiptFile.exists())) continue;
    const receipt = await receiptFile.json();
    if (targets.some((target) => target.path === receipt.environment.targetRoot)) continue;
    targets.push({ path: receipt.environment.targetRoot, owner: join(owner, 'study') });
  }
  for (const target of targets.splice(0)) {
    if (
      !target.path.startsWith(join(ROOT, 'target/rust-cost-baseline-')) ||
      (await readFile(join(target.path, '.rust-cost-baseline-owner'), 'utf8')) !== target.owner
    )
      throw new Error(
        `Driver fixture cleanup: expected marked private target | received: ${target.path}`
      );
    await rm(target.path, { recursive: true, force: true });
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
class DiscardedDriverOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}

/** No Rust compilation: a named Cargo fake stops inside the first declared build. */
class FakeRustCostCommands {
  environment(ambient: NodeJS.ProcessEnv, bin: string): NodeJS.ProcessEnv {
    const environment = nativeQualificationEnvironment(ambient);
    delete environment.RUSTC;
    delete environment.RUSTC_WRAPPER;
    delete environment.RUSTC_WORKSPACE_WRAPPER;
    return { ...environment, PATH: `${bin}:${environment.PATH}` };
  }
  constructor(private readonly directory: string) {}
  async create(): Promise<string> {
    const bin = join(this.directory, 'bin');
    await mkdir(bin);
    const sources: Record<string, string> = {
      git: `const args = process.argv.slice(2); if (args[0] === 'rev-parse') console.log('0000000000000000000000000000000000000000'); else if (args[0] === 'ls-files') console.log('Cargo.toml\\nCargo.lock\\nrust-toolchain.toml\\ncrates/mangostudio-runtime/src/main.rs'); else if (args[0] !== 'status') throw new Error('Unexpected fake git command: '+args);`,
      rustc: `console.log('rustc 1.99.0 (fixture)\\nhost: x86_64-unknown-linux-gnu');`,
      cargo: `
const args = process.argv.slice(2);
if (args.includes('--worker')) { setInterval(() => {}, 1000); await new Promise(() => {}); }
else if (args[0] === '-V') console.log('cargo fixture');
else if (args[0] === 'metadata') console.log(JSON.stringify({ packages: [{ name: 'fixture', description: 'x'.repeat(2 * 2 ** 20) }], workspace_members: [], resolve: { nodes: [] } }));
else if (args[0] === 'tree') console.log('fixture locked dependency graph');
else if (args[0] === 'build') {
  const worker = Bun.spawn([process.execPath, import.meta.path, '--worker'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const stat = await Bun.file('/proc/'+process.ppid+'/stat').text();
  const driverPid = Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
  await Bun.write(${JSON.stringify(join(this.directory, 'stall-reached'))}, JSON.stringify({ cargoPid: process.pid, workerPid: worker.pid, driverPid }));
  while (!(await Bun.file(${JSON.stringify(join(this.directory, 'cancel-now'))}).exists())) await Bun.sleep(5);
  process.kill(driverPid, 'SIGTERM');
  setInterval(() => {}, 1000); await new Promise(() => {});
} else throw new Error('Unexpected fake cargo command: '+args);
`,
    };
    for (const [name, source] of Object.entries(sources)) {
      const path = join(bin, name);
      await Bun.write(path, `#!/usr/bin/env bun\n${source}\n`);
      await chmod(path, 0o755);
    }
    return bin;
  }
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
  'Rust cost driver cancellation',
  () => {
    it('preserves the production guard against an inherited Cargo target', async () => {
      const root = await mkdtemp(join(tmpdir(), 'rust-cost-driver-guard-test-'));
      scratch.push(root);
      const fixture = new FakeRustCostCommands(root);
      const bin = await fixture.create();
      const environment = fixture.environment(process.env, bin);
      const result = await runNativeCommand({
        label: 'driver-rejected-environment',
        command: [
          process.execPath,
          'scripts/bench/rust-costs.ts',
          '--execute',
          '--out',
          join(root, 'study'),
        ],
        root: ROOT,
        out: root,
        env: { ...environment, CARGO_TARGET_DIR: join(root, 'inherited-target') },
        timeoutSeconds: 10,
        pollIntervalMs: 20,
        stream: new DiscardedDriverOutput(),
      });
      const stderr = await readFile(
        join(root, 'logs/driver-rejected-environment.stderr.log'),
        'utf8'
      );
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.settlement.empty).toBe(true);
      expect(stderr).toContain(
        'Rust baseline environment: expected repository profile and compiler | received override names: CARGO_TARGET_DIR'
      );
      expect(await Bun.file(join(root, 'stall-reached')).exists()).toBe(false);
    });
    it('cancels the actual driver build, retains its interrupted attempt and settles the Cargo family', async () => {
      const root = await mkdtemp(join(tmpdir(), 'rust-cost-driver-cancel-test-'));
      scratch.push(root);
      const fixture = new FakeRustCostCommands(root);
      const bin = await fixture.create();
      const out = join(root, 'study');
      const pending = runNativeCommand({
        label: 'driver-cancel',
        command: [process.execPath, 'scripts/bench/rust-costs.ts', '--execute', '--out', out],
        root: ROOT,
        out: root,
        env: fixture.environment(
          { ...process.env, CARGO_TARGET_DIR: join(root, 'inherited-qualification-target') },
          bin
        ),
        timeoutSeconds: 20,
        pollIntervalMs: 20,
        stream: new DiscardedDriverOutput(),
      });
      const barrier = new FakeBenchmarkCancelBarrier(root);
      owned.push(...(await barrier.observe(join(bin, 'cargo'), pending)));
      await barrier.release();
      const result = await pending;
      owned.push(...result.settlement.survivors);
      const receipt = JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8')) as {
        complete: boolean;
        environment: { targetRoot: string };
        attempts: Array<{
          label: string;
          status: string;
          valid: boolean;
          command: { canceled?: boolean; settlement: { empty: boolean } };
        }>;
      };
      targets.push({ path: receipt.environment.targetRoot, owner: out });
      const metadata = JSON.parse(await readFile(join(out, 'metadata-default.json'), 'utf8'));
      expect(metadata.packages[0].description).toHaveLength(2 * 2 ** 20);
      const metadataCommand = JSON.parse(
        await readFile(join(out, '1-metadata-default.json'), 'utf8')
      );
      expect(metadataCommand.machineStdoutMaxLineBytes).toBe(8 * 2 ** 20);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.settlement.empty).toBe(true);
      expect(receipt.complete).toBe(false);
      expect(receipt.attempts).toHaveLength(1);
      expect(receipt.attempts[0]).toMatchObject({
        label: 'runtime-empty-1',
        status: 'canceled',
        valid: false,
        command: { canceled: true, settlement: { empty: true } },
      });
      const events = (await readFile(join(out, 'attempts.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.kind)).toEqual(['started', 'finished']);
      expect(events[1].status).toBe('canceled');
      const current = await snapshotNativeProcesses();
      expect(
        owned.some((fixture) =>
          current.some((row) => row.pid === fixture.pid && row.identity === fixture.identity)
        )
      ).toBe(false);
    }, 30_000);
  }
);
