import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { dirname, join, relative } from 'node:path';

import {
  AOT_RECORD_ORDER_FLAG,
  aotOrderFlag,
  type AotOrderPlan,
  aotOrderSkipReason,
  type AotOrderSteps,
  type AotOrderSummary,
  aotOrderWarning,
  type CompileOutcome,
  compileWithAotOrder,
  type DeadlineTimer,
  parseAotOrder,
  recordAotOrder,
} from '../lib/aot-order';

const FAKE_HUB = join(import.meta.dir, 'support', 'fake-recording-hub.ts');

describe('parseAotOrder', () => {
  test('counts the functions of a multi-module program file', () => {
    expect(
      parseAotOrder('aot-order v1\nP 39150\nF = 7066 b0 - 0:0 \nF = 10562 b0 - 0:0 \n')
    ).toEqual({ functionCount: 2, unknownLineCount: 0, unknownLineKinds: [] });
  });

  test('counts the functions of a single-module program file', () => {
    expect(parseAotOrder('aot-order v1\nM 0 entry.ts\nF 0 0 b0 - 1:1 \n')).toEqual({
      functionCount: 1,
      unknownLineCount: 0,
      unknownLineKinds: [],
    });
  });

  test('accepts the entry-module line newer Bun canaries write', () => {
    // Written by Bun 1.4.5-canary.1+8b22022db, which CI installs.
    expect(parseAotOrder('aot-order v1\nE entry.ts\nM 0 entry.ts\nF 0 0 b0 - 1:1 \n')).toEqual({
      functionCount: 1,
      unknownLineCount: 0,
      unknownLineKinds: [],
    });
  });

  test('passes a line kind it does not know through, counted and named', () => {
    expect(
      parseAotOrder('aot-order v1\nP 1\nZ 9 new-kind\nF = 1 b0 - 0:0 \nQ x\nZ 10 again\n')
    ).toEqual({ functionCount: 1, unknownLineCount: 3, unknownLineKinds: ['Q', 'Z'] });
  });

  test('leaves the shape of a function line to Bun', () => {
    expect(parseAotOrder('aot-order v1\nF a different layout\n').functionCount).toBe(1);
  });

  test.each([
    ['an empty file', '', 'expected first line "aot-order v1" | received: ""'],
    [
      'another format version',
      'aot-order v2\nP 1\nF = 1 b0 - 0:0 \n',
      'expected first line "aot-order v1" | received: "aot-order v2"',
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
  test('lets only a requested native build on a Linux host record', () => {
    expect(aotOrderSkipReason('native', 'linux', true)).toBeNull();
    expect(aotOrderSkipReason('native', 'darwin', true)).toBe(
      'Bun records AOT function order on Linux only (host: darwin)'
    );
    expect(aotOrderSkipReason('native', 'win32', true)).toContain('host: win32');
    expect(aotOrderSkipReason('bytecode', 'linux', true)).toContain('--compiler bytecode');
  });

  test('does not record for a build that did not ask for it', () => {
    expect(aotOrderSkipReason('native', 'linux', false)).toBe(
      'not requested (pass --production or --require-aot-order to record it)'
    );
  });
});

describe('aotOrderWarning', () => {
  test('finds the line Bun prints for a file it cannot use among other compiler output', () => {
    const stderr =
      "warn: TS100058: the pattern of this regular expression isn't a constant\n" +
      'warn: --aot-order: /tmp/hub.order is not an order file. Nothing is placed by it\n';

    expect(aotOrderWarning(stderr)).toBe(
      'warn: --aot-order: /tmp/hub.order is not an order file. Nothing is placed by it'
    );
  });

  test('finds nothing in output that only mentions other warnings', () => {
    expect(aotOrderWarning('warn: TS100058: not constant\n')).toBeNull();
    expect(aotOrderWarning('')).toBeNull();
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

/** Polls until `path` exists; names the path if it never does. */
async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > until) {
      throw new Error(`expected ${path} to exist within ${timeoutMs} ms | received: not found`);
    }
    await Bun.sleep(20);
  }
}

/** Polls until the process is gone (a zombie still answers signal 0 until it is reaped). */
async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > until) {
      throw new Error(`expected pid ${pid} to be gone within ${timeoutMs} ms | received: alive`);
    }
    await Bun.sleep(20);
  }
}

/** A recording ceiling the test fires by hand, so no test races a hub's start-up against a clock. */
function manualDeadline(): { timer: DeadlineTimer; expire: () => void } {
  let expire: (() => void) | undefined;
  return {
    timer: (_ms, onExpire) => {
      expire = onExpire;
      return () => {
        expire = undefined;
      };
    },
    expire: () => {
      if (!expire) throw new Error('expected the recording to have started its deadline');
      expire();
    },
  };
}

// Recording is a Linux-only build step: `aotOrderSkipReason` refuses every other host, and the
// recorder itself needs POSIX behaviour Windows lacks (it spawns an executable script, stops the hub
// with a catchable SIGTERM so it writes its file, and kills its process group with `kill(-pid)`).
// Windows therefore never reaches `recordAotOrder`; the refusal is covered on every host by the
// `aotOrderSkipReason` and `compileWithAotOrder` tests.
describe.skipIf(process.platform === 'win32')('recordAotOrder', () => {
  let workDir: string;
  let orderFile: string;
  const noWorkload = (): Promise<void> => Promise.resolve();
  // The recorder gives the hub an allowlisted environment, so the fake hub reads how to behave
  // from a file beside the order file rather than from a variable.
  const fakeHubMode = (mode: string): void => {
    mkdirSync(dirname(orderFile), { recursive: true });
    writeFileSync(`${orderFile}.mode`, mode);
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aot-order-test-'));
    orderFile = join(workDir, 'nested', 'hub.order');
    chmodSync(FAKE_HUB, 0o755);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('stops the hub, reads the file it wrote and returns its summary', async () => {
    fakeHubMode('records');
    const requested: string[] = [];

    const summary = await recordAotOrder(FAKE_HUB, orderFile, {
      workload: (baseUrl) => {
        requested.push(baseUrl);
        return Promise.resolve();
      },
    });

    expect(summary).toEqual({ functionCount: 2, unknownLineCount: 0, unknownLineKinds: [] });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('keeps the hub inside a throwaway home, on loopback, and deletes the home afterwards', async () => {
    fakeHubMode('records');

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
    fakeHubMode('silent-exit');

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      /expected the recording hub to write .*hub\.order on exit \| received: no file/
    );
  });

  test('fails on a file Bun would ignore with only a warning', async () => {
    fakeHubMode('malformed');

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      'expected first line "aot-order v1" | received: "not an order file"'
    );
  });

  test('fails when the hub dies before it answers health', async () => {
    fakeHubMode('crash');

    await expect(recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload })).rejects.toThrow(
      /expected http:\/\/127\.0\.0\.1:\d+\/api\/health to answer 200 before the hub exited \| received: hub exit 3/
    );
  });

  test('stops a hub that never answers at the deadline, kills it and deletes its home', async () => {
    fakeHubMode('no-health');
    const deadline = manualDeadline();

    const recording = recordAotOrder(FAKE_HUB, orderFile, {
      workload: noWorkload,
      deadlineMs: 400,
      setDeadline: deadline.timer,
    });
    // The test, not the clock, decides when the ceiling is reached: only once the hub is up.
    await waitForFile(`${orderFile}.pid`);
    deadline.expire();

    await expect(recording).rejects.toThrow(
      'expected the recording run to finish within 400 ms | received: still running (waiting for the hub to answer health)'
    );
    const pid = Number(readFileSync(`${orderFile}.pid`, 'utf8'));
    const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<string, string>;
    await waitUntilDead(pid);
    expect(existsSync(env.MANGO_HOME as string)).toBe(false);
  });

  test('does not take a healthy answer for the hub it started when the state file is not its own', async () => {
    fakeHubMode('no-state');
    const deadline = manualDeadline();

    const recording = recordAotOrder(FAKE_HUB, orderFile, {
      workload: noWorkload,
      setDeadline: deadline.timer,
    });
    // The fake answers health at least twice before this marker exists, so the recorder has
    // already seen a 200 and refused it.
    await waitForFile(`${orderFile}.health-2`);
    deadline.expire();

    await expect(recording).rejects.toThrow(
      /answered 200 but .*server\.json does not name pid \d+ and port \d+, so the listener is not this hub/
    );
  });

  test('gives the hub only the environment it needs, none of the build secrets', async () => {
    fakeHubMode('records');
    const planted: Record<string, string> = {
      MANGOSTUDIO_RUNTIME_BINARY: '/developer/runtime',
      GITHUB_TOKEN: 'ghs_planted_token',
      OPENAI_API_KEY: 'sk-planted',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PUBLIC_URL: 'https://planted.invalid',
      ALLOWED_ORIGINS: 'https://planted.invalid',
      CLAUDE_CONFIG_DIR: '/developer/.claude',
      LC_ALL: 'C.UTF-8',
    };
    const previous = Object.fromEntries(
      Object.keys(planted).map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, planted);
    try {
      await recordAotOrder(FAKE_HUB, orderFile, { workload: noWorkload });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<string, string>;
    const leaked = Object.keys(planted).filter((name) => name !== 'LC_ALL' && name in env);
    expect(leaked, `variables the hub should not see: ${leaked.join(', ')}`).toEqual([]);
    expect(env.LC_ALL).toBe('C.UTF-8');
    expect(env.PATH).toBe(process.env.PATH as string);
    expect(env.MANGO_UPDATES_CHECK).toBe('0');
  });

  describe('when the build is cancelled mid-recording', () => {
    const RUNNER = join(import.meta.dir, 'support', 'record-order-runner.ts');

    test.each([
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const)('a %s leaves no hub process and no home behind', async (signal, expectedExit) => {
      const runner = Bun.spawn([process.execPath, RUNNER, FAKE_HUB, orderFile], {
        env: process.env,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      try {
        await waitForFile(`${orderFile}.workload`);
        const pid = Number(readFileSync(`${orderFile}.pid`, 'utf8'));
        const env = JSON.parse(readFileSync(`${orderFile}.env.json`, 'utf8')) as Record<
          string,
          string
        >;
        expect(isAlive(pid), 'the hub should be running mid-recording').toBe(true);
        expect(existsSync(env.MANGO_HOME as string)).toBe(true);

        runner.kill(signal);
        const exit = await runner.exited;

        expect(exit).toBe(expectedExit);
        await waitUntilDead(pid);
        expect(existsSync(env.MANGO_HOME as string), 'temp home after cancel').toBe(false);
      } finally {
        runner.kill('SIGKILL');
      }
    });
  });

  test('kills the hub and deletes its home when the workload fails', async () => {
    fakeHubMode('records');

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
  /** What the compiler prints to stderr when it is given the order file. */
  shippingStderr = '';
  /** Line kinds the recorded file reports as unknown to the parser. */
  unknownLineKinds: string[] = [];
  /** What the order directory held when the recorder ran. */
  orderDirAtRecording: string[] = [];
  private compiles = 0;
  private clock = 0;

  constructor(private readonly orderDir: string) {}

  compile(extraFlags: readonly string[], outfile: string): Promise<CompileOutcome> {
    const index = this.compiles;
    this.compiles += 1;
    this.calls.push(`compile ${extraFlags.join(' ') || '(no extra flags)'} -> ${outfile}`);
    // The recording binary is a large file in `record/`; the plan must not leave it behind.
    if (outfile.startsWith(join(this.orderDir, 'record'))) {
      mkdirSync(join(this.orderDir, 'record'), { recursive: true });
      writeFileSync(outfile, 'recording binary');
    }
    return Promise.resolve({
      ok: !this.failingCompiles.has(index),
      stdout: `compile ${index}`,
      stderr: extraFlags.some((flag) => flag.startsWith('--aot-order=')) ? this.shippingStderr : '',
    });
  }

  record(recordingBinary: string, orderFile: string): Promise<AotOrderSummary> {
    this.calls.push(`record ${recordingBinary} -> ${orderFile}`);
    this.orderDirAtRecording = existsSync(this.orderDir)
      ? // Glob yields native separators; list with `/` so the expectation reads the same everywhere.
        [...new Bun.Glob('**/*').scanSync(this.orderDir)].map((path) => path.replaceAll('\\', '/'))
      : [];
    if (this.recordingError) return Promise.reject(this.recordingError);
    mkdirSync(this.orderDir, { recursive: true });
    writeFileSync(orderFile, 'recorded');
    return Promise.resolve({
      functionCount: 12,
      unknownLineCount: this.unknownLineKinds.length,
      unknownLineKinds: this.unknownLineKinds,
    });
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

    expect(result).toEqual({
      ok: true,
      stdout: 'compile 1',
      stderr: '',
      // The hash of the file the shipping compile was given, for the receipt.
      orderSha256: createHash('sha256').update('recorded').digest('hex'),
    });
    expect(steps.calls).toEqual([
      `compile --aot-record-order -> ${join(orderDir, 'record', 'mangostudio')}`,
      `record ${join(orderDir, 'record', 'mangostudio')} -> ${join(orderDir, 'hub.order')}`,
      `compile --aot-order=${join(orderDir, 'hub.order')} -> /out/mangostudio`,
    ]);
    expect(steps.logs.join('\n')).toContain('12 functions recorded in 2.5 s');
    expect(steps.warnings).toEqual([]);
  });

  test('logs the line kinds of an order file it does not know, and still ships with it', async () => {
    steps.unknownLineKinds = ['Q', 'Z'];

    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result.ok).toBe(true);
    expect(steps.logs.join('\n')).toContain(
      '2 order-file lines of kind Q, Z are unknown to this build and passed through to Bun'
    );
    expect(steps.warnings).toEqual([]);
  });

  test('deletes the recording binary after the shipping compile and keeps the order file', async () => {
    await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(existsSync(join(orderDir, 'record'))).toBe(false);
    expect(readFileSync(join(orderDir, 'hub.order'), 'utf8')).toBe('recorded');
  });

  test('deletes the recording binary when recording fails too', async () => {
    steps.recordingError = new Error('aot order: no file');

    await compileWithAotOrder(plan({ required: true }), steps, '/out/mangostudio');

    expect(existsSync(join(orderDir, 'record'))).toBe(false);
  });

  test('warns, and records no order hash, when Bun reports it did not use the order file', async () => {
    steps.shippingStderr =
      'warn: --aot-order: /x/hub.order is not an order file. Nothing is placed by it\n';

    const result = await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    expect(result.ok).toBe(true);
    expect(result.orderSha256).toBeNull();
    expect(steps.warnings).toHaveLength(1);
    expect(steps.warnings[0]).toContain(
      'Bun did not apply the AOT function order for linux-x64: warn: --aot-order: /x/hub.order is not an order file'
    );
  });

  test('fails the build when Bun reports it did not use the order file and one is required', async () => {
    steps.shippingStderr =
      'warn: --aot-order: /x/hub.order is not an order file. Nothing is placed by it\n';

    const result = await compileWithAotOrder(plan({ required: true }), steps, '/out/mangostudio');

    expect(result.ok).toBe(false);
    expect(result.failure).toContain('Bun did not apply the AOT function order for linux-x64');
    expect(result.orderSha256).toBeNull();
  });

  test('never lets an order file from an earlier build reach the compile', async () => {
    mkdirSync(join(orderDir, 'record'), { recursive: true });
    writeFileSync(join(orderDir, 'hub.order'), 'aot-order v1\nF = 1 b0 - 0:0 \n');
    writeFileSync(join(orderDir, 'record', 'mangostudio'), 'old binary');

    await compileWithAotOrder(plan(), steps, '/out/mangostudio');

    // Only the recording binary this build just compiled; the old order file is gone, and the
    // recording binary was rebuilt (the fake writes fresh bytes) rather than left from before.
    expect(steps.orderDirAtRecording).toEqual(['record/mangostudio']);
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
