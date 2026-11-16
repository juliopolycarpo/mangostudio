import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  AOT_RECORD_ORDER_FLAG,
  aotOrderFlag,
  type AotOrderPlan,
  aotOrderSkipReason,
  type AotOrderSteps,
  type AotOrderSummary,
  type CompileOutcome,
  compileWithAotOrder,
  parseAotOrder,
  recordAotOrder,
} from '../lib/aot-order';

const FAKE_HUB = join(import.meta.dir, 'support', 'fake-recording-hub.ts');

describe('parseAotOrder', () => {
  test('counts the functions of a multi-module program file', () => {
    expect(
      parseAotOrder('aot-order v1\nP 39150\nF = 7066 b0 - 0:0 \nF = 10562 b0 - 0:0 \n')
    ).toEqual({ functionCount: 2 });
  });

  test('counts the functions of a single-module program file', () => {
    expect(parseAotOrder('aot-order v1\nM 0 entry.ts\nF 0 0 b0 - 1:1 \n')).toEqual({
      functionCount: 1,
    });
  });

  test.each([
    ['an empty file', '', 'expected first line "aot-order v1" | received: ""'],
    [
      'another format version',
      'aot-order v2\nP 1\nF = 1 b0 - 0:0 \n',
      'expected first line "aot-order v1" | received: "aot-order v2"',
    ],
    [
      'a line of no known kind',
      'aot-order v1\nP 1\nX = 1 b0 - 0:0 \n',
      'expected a "P <n>", "M <n> <module>" or "F <...>" line | received: "X = 1 b0 - 0:0 "',
    ],
    [
      'a function line with no index',
      'aot-order v1\nP 1\nF = x b0 - 0:0 \n',
      'received: "F = x b0 - 0:0 "',
    ],
    [
      'no recorded function',
      'aot-order v1\nP 1\n',
      'expected at least one "F ..." line | received: none',
    ],
  ])('names the problem with %s', (_label, text, expected) => {
    expect(() => parseAotOrder(text)).toThrow(expected);
  });
});

describe('aotOrderSkipReason', () => {
  test('lets only a native build on a Linux host record', () => {
    expect(aotOrderSkipReason('native', 'linux')).toBeNull();
    expect(aotOrderSkipReason('native', 'darwin')).toBe(
      'Bun records AOT function order on Linux only (host: darwin)'
    );
    expect(aotOrderSkipReason('native', 'win32')).toContain('host: win32');
    expect(aotOrderSkipReason('bytecode', 'linux')).toContain('--compiler bytecode');
  });
});

test('compiler flags spell what bun build reads', () => {
  expect(AOT_RECORD_ORDER_FLAG).toBe('--aot-record-order');
  expect(aotOrderFlag('/tmp/hub.order')).toBe('--aot-order=/tmp/hub.order');
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('recordAotOrder', () => {
  let workDir: string;
  let orderFile: string;
  const previousMode = process.env.FAKE_RECORDING_HUB;
  const noWorkload = (): Promise<void> => Promise.resolve();

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aot-order-test-'));
    orderFile = join(workDir, 'nested', 'hub.order');
    chmodSync(FAKE_HUB, 0o755);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.FAKE_RECORDING_HUB;
    else process.env.FAKE_RECORDING_HUB = previousMode;
  });

  test('stops the hub, reads the file it wrote and returns its summary', async () => {
    process.env.FAKE_RECORDING_HUB = 'records';
    const requested: string[] = [];

    const summary = await recordAotOrder(FAKE_HUB, orderFile, {
      workload: (baseUrl) => {
        requested.push(baseUrl);
        return Promise.resolve();
      },
    });

    expect(summary).toEqual({ functionCount: 2 });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('keeps the hub inside a throwaway home, on loopback, and deletes the home afterwards', async () => {
    process.env.FAKE_RECORDING_HUB = 'records';

    await recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload });

    const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<string, string>;
    const home = env.MANGO_HOME as string;
    expect(relative(tmpdir(), home)).toMatch(/^mangostudio-hub-run-[^/]+$/);
    // Every location the hub could write is under that home: nothing points at the developer's.
    for (const name of [
      'HOME',
      'USERPROFILE',
      'DATABASE_PATH',
      'UPLOADS_DIR',
      'IMAGES_DIR',
      'TOOL_IMAGES_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
    ]) {
      expect(`${name}=${env[name]}`).toStartWith(`${name}=${home}`);
    }
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.BUN_AOT_ORDER_OUT).toBe(orderFile);
    expect(env.HOME).not.toBe(homedir());
    expect(existsSync(home)).toBe(false);
  });

  test('fails when the hub exits without writing the file', async () => {
    process.env.FAKE_RECORDING_HUB = 'silent-exit';

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      /expected the recording hub to write .*hub\.order on exit \| received: no file/
    );
  });

  test('fails on a file Bun would ignore with only a warning', async () => {
    process.env.FAKE_RECORDING_HUB = 'malformed';

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      'expected first line "aot-order v1" | received: "not an order file"'
    );
  });

  test('fails when the hub dies before it answers health', async () => {
    process.env.FAKE_RECORDING_HUB = 'crash';

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      /expected http:\/\/127\.0\.0\.1:\d+\/api\/health to answer 200 before the hub exited \| received: hub exit 3/
    );
  });

  test('stops a hub that never answers at the deadline, kills it and deletes its home', async () => {
    process.env.FAKE_RECORDING_HUB = 'no-health';

    await expect(
      recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload, deadlineMs: 400 })
    ).rejects.toThrow(
      'expected the recording run to finish within 400 ms | received: still running'
    );

    const pid = Number(readFileSync(`${orderFile}.pid`, 'utf8'));
    const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<string, string>;
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(env.MANGO_HOME as string)).toBe(false);
  });

  test('kills the hub and deletes its home when the workload fails', async () => {
    process.env.FAKE_RECORDING_HUB = 'records';

    await expect(
      recordAotOrder(FAKE_HUB, orderFile, {
        workload: () => Promise.reject(new Error('GET /api/chats/: expected 2xx | received 500')),
      })
    ).rejects.toThrow('GET /api/chats/: expected 2xx | received 500');

    const pid = Number(readFileSync(`${orderFile}.pid`, 'utf8'));
    const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<string, string>;
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(env.MANGO_HOME as string)).toBe(false);
  });
});

/** Replaces the compiler, the recorder and the clock around `compileWithAotOrder`. */
class FakeAotOrderSteps implements AotOrderSteps {
  readonly calls: string[] = [];
  readonly logs: string[] = [];
  readonly warnings: string[] = [];
  /** Compile calls (0-based) that fail. */
  failingCompiles = new Set<number>();
  recordingError: Error | null = null;
  /** What the order directory held when the recorder ran. */
  orderDirAtRecording: string[] = [];
  private compiles = 0;
  private clock = 0;

  constructor(private readonly orderDir: string) {}

  compile(extraFlags: readonly string[], outfile: string): Promise<CompileOutcome> {
    const index = this.compiles;
    this.compiles += 1;
    this.calls.push(`compile ${extraFlags.join(' ') || '(no extra flags)'} -> ${outfile}`);
    return Promise.resolve({ ok: !this.failingCompiles.has(index), stdout: `compile ${index}` });
  }

  record(recordingBinary: string, orderFile: string): Promise<AotOrderSummary> {
    this.calls.push(`record ${recordingBinary} -> ${orderFile}`);
    this.orderDirAtRecording = existsSync(this.orderDir)
      ? [...new Bun.Glob('**/*').scanSync(this.orderDir)]
      : [];
    if (this.recordingError) return Promise.reject(this.recordingError);
    mkdirSync(this.orderDir, { recursive: true });
    writeFileSync(orderFile, 'recorded');
    return Promise.resolve({ functionCount: 12 });
  }

  log(message: string): void {
    this.logs.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  now(): number {
    this.clock += 2500;
    return this.clock;
  }
}

describe('compileWithAotOrder', () => {
  let orderDir: string;
  let steps: FakeAotOrderSteps;
  const plan = (overrides: Partial<AotOrderPlan> = {}): AotOrderPlan => ({
    target: 'linux-x64',
    skipReason: null,
    required: false,
    orderDir,
    binaryName: 'mangostudio',
    ...overrides,
  });

  beforeEach(() => {
    orderDir = join(mkdtempSync(join(tmpdir(), 'aot-order-plan-')), 'linux-x64');
    steps = new FakeAotOrderSteps(orderDir);
  });

  afterEach(() => {
    rmSync(join(orderDir, '..'), { recursive: true, force: true });
  });

  test('ships a binary compiled with the order recorded from its own recording build', async () => {
    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result).toEqual({ ok: true, stdout: 'compile 1' });
    expect(steps.calls).toEqual([
      `compile --aot-record-order -> ${join(orderDir, 'record', 'mangostudio')}`,
      `record ${join(orderDir, 'record', 'mangostudio')} -> ${join(orderDir, 'hub.order')}`,
      `compile --aot-order=${join(orderDir, 'hub.order')} -> /out/mangostudio`,
    ]);
    expect(steps.logs.join('\n')).toContain('12 functions recorded in 2.5 s');
    expect(steps.warnings).toEqual([]);
  });

  test('never lets an order file from an earlier build reach the compile', async () => {
    mkdirSync(join(orderDir, 'record'), { recursive: true });
    writeFileSync(join(orderDir, 'hub.order'), 'aot-order v1\nF = 1 b0 - 0:0 \n');
    writeFileSync(join(orderDir, 'record', 'mangostudio'), 'old binary');

    await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(steps.orderDirAtRecording).toEqual([]);
    expect(readFileSync(join(orderDir, 'hub.order'), 'utf8')).toBe('recorded');
  });

  test('builds without an order and warns with the reason when recording fails locally', async () => {
    steps.recordingError = new Error(
      'aot order: expected the recording run to finish within 120000 ms | received: still running'
    );

    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result.ok).toBe(true);
    expect(steps.calls.at(-1)).toBe('compile (no extra flags) -> /out/mangostudio');
    expect(steps.warnings).toHaveLength(1);
    expect(steps.warnings[0]).toContain(
      'could not record the AOT function order for linux-x64: aot order: expected the recording run to finish within 120000 ms'
    );
    expect(steps.warnings[0]).toContain('Building without it');
  });

  test('builds without an order and warns when the recording binary does not compile', async () => {
    steps.failingCompiles.add(0);

    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result.ok).toBe(true);
    expect(steps.calls.some((call) => call.startsWith('record '))).toBe(false);
    expect(steps.warnings[0]).toContain(
      'the recording binary did not compile (--aot-record-order)'
    );
  });

  test('fails the build, naming the reason, when recording fails and an order is required', async () => {
    steps.recordingError = new Error(
      'aot order: expected first line "aot-order v1" | received: ""'
    );

    const result = await compileWithAotOrder(plan({ required: true }), steps, '/out/mangostudio');

    expect(result.ok).toBe(false);
    expect(result.failure).toBe(
      'could not record the AOT function order for linux-x64: aot order: expected first line "aot-order v1" | received: ""'
    );
    expect(steps.calls).toHaveLength(2);
    expect(steps.warnings).toEqual([]);
  });

  test('fails when the shipping compile fails, even with an order recorded', async () => {
    steps.failingCompiles.add(1);

    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result.ok).toBe(false);
  });

  test.each([false, true])(
    'compiles once and says why when the host cannot record (required: %p)',
    async (required) => {
      const result = await compileWithAotOrder(
        plan({
          required,
          skipReason: 'Bun records AOT function order on Linux only (host: darwin)',
        }),
        steps,
        '/out/mangostudio'
      );

      expect(result.ok).toBe(true);
      expect(steps.calls).toEqual(['compile (no extra flags) -> /out/mangostudio']);
      expect(steps.logs).toEqual([
        '   AOT function order skipped for linux-x64: Bun records AOT function order on Linux only (host: darwin)',
      ]);
    }
  );
});

// The installed Bun must still accept the two flags and the file it writes. This compiles a
// one-function program, so it costs well under a second.
describe.skipIf(process.platform !== 'linux')('the installed Bun', () => {
  test('records an order file that --aot-order accepts without a warning', async () => {
    const work = mkdtempSync(join(tmpdir(), 'aot-order-bun-'));
    try {
      writeFileSync(
        join(work, 'entry.ts'),
        'function hot(n: number) { return n * 2; }\nconsole.log(hot(21));\n'
      );
      const compile = async (flag: string, outfile: string): Promise<string> => {
        const child = Bun.spawn(
          [process.execPath, 'build', 'entry.ts', '--compile', '--aot', flag, '--outfile', outfile],
          { cwd: work, stdout: 'pipe', stderr: 'pipe' }
        );
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(`bun build ${flag} exit ${code}: ${err}`).toBe(`bun build ${flag} exit 0: ${err}`);
        return out + err;
      };
      const recordingBinary = join(work, 'record');
      const order = join(work, 'hub.order');
      await compile(AOT_RECORD_ORDER_FLAG, recordingBinary);
      const run = Bun.spawn([recordingBinary], {
        env: { ...process.env, BUN_AOT_ORDER_OUT: order },
        stdout: 'ignore',
      });
      await run.exited;

      expect(parseAotOrder(readFileSync(order, 'utf8')).functionCount).toBeGreaterThan(0);
      const output = await compile(aotOrderFlag(order), join(work, 'shipped'));
      expect(output).not.toContain('is not an order file');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
