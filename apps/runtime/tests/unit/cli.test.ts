import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_CODES, type Frame, RemoteError, Session } from '@mangostudio/protocol';
import { type SpawnedPeer, spawnPort } from '@mangostudio/protocol/spawn';
import { rejectionOf } from '@mangostudio/protocol/testing';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import { parseRuntimeCliArgs, RUNTIME_CLI_USAGE } from '../../src/cli';
import { LEGACY_HELLO_1_0_1_NDJSON_LINE } from '../fixtures/legacy-hello-1-0-1';

const CLI_ENTRY = join(import.meta.dir, '../../src/cli.ts');
const SPAWN_TIMEOUT_MS = 15_000;

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A runtime home of its own, so a spawned CLI never reads the developer's. */
async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mango-runtime-cli-'));
  homes.push(home);
  return home;
}

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: readonly string[],
  options: { readonly version?: string; readonly env?: Record<string, string> } = {}
): Promise<CliRun> {
  const child = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    env: {
      ...process.env,
      VERSION: options.version ?? '9.9.9-test',
      MANGO_HOME: await isolatedHome(),
      ...options.env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('parseRuntimeCliArgs', () => {
  it('accepts the flag and bare-word spelling of every mode', () => {
    expect(parseRuntimeCliArgs(['--stdio'])).toEqual({ command: 'stdio' });
    expect(parseRuntimeCliArgs(['stdio'])).toEqual({ command: 'stdio' });
    expect(parseRuntimeCliArgs(['--version'])).toEqual({ command: 'version' });
    expect(parseRuntimeCliArgs(['-v'])).toEqual({ command: 'version' });
    expect(parseRuntimeCliArgs(['version'])).toEqual({ command: 'version' });
    expect(parseRuntimeCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseRuntimeCliArgs(['-h'])).toEqual({ command: 'help' });
  });

  it('treats a bare invocation as a help request', () => {
    expect(parseRuntimeCliArgs([])).toEqual({ command: 'help' });
  });

  it('reports the offending argument instead of guessing a mode', () => {
    expect(parseRuntimeCliArgs(['--serve'])).toEqual({ command: 'unknown', argument: '--serve' });
    expect(parseRuntimeCliArgs(['--stdio', '--extra'])).toEqual({
      command: 'unknown',
      argument: '--extra',
    });
  });

  it('parses connect with a hub and a piped token', () => {
    expect(
      parseRuntimeCliArgs(['connect', '--hub', 'wss://hub.test/api/runtime', '--token', '-'])
    ).toEqual({
      command: 'connect',
      args: { hubUrl: 'wss://hub.test/api/runtime', tokenSource: 'stdin' },
    });
  });

  it('lets connect fall back to whatever a previous run stored', () => {
    expect(parseRuntimeCliArgs(['connect'])).toEqual({
      command: 'connect',
      args: { tokenSource: 'stored' },
    });
  });

  it('refuses a token passed as an argument', () => {
    // argv is readable by every process on the machine, so there is deliberately
    // no spelling of `--token <secret>` that works.
    expect(parseRuntimeCliArgs(['connect', '--token', 'mrt_abc.def'])).toEqual({
      command: 'unknown',
      argument: '--token',
    });
  });

  it('refuses a hub flag with nothing after it', () => {
    expect(parseRuntimeCliArgs(['connect', '--hub'])).toEqual({
      command: 'unknown',
      argument: '--hub',
    });
  });

  it('parses serve with a listen address and a piped token', () => {
    expect(parseRuntimeCliArgs(['serve', '--listen', '0.0.0.0:8787', '--token', '-'])).toEqual({
      command: 'serve',
      args: { listen: '0.0.0.0:8787', tokenSource: 'stdin' },
    });
  });

  it('allows serve without --listen when a previous run stored the address', () => {
    expect(parseRuntimeCliArgs(['serve'])).toEqual({
      command: 'serve',
      args: { tokenSource: 'stored' },
    });
  });

  it('refuses a serve token passed as an argument', () => {
    expect(parseRuntimeCliArgs(['serve', '--listen', '8787', '--token', 'secret'])).toEqual({
      command: 'unknown',
      argument: '--token',
    });
  });

  it('parses every non-interactive setup form', () => {
    expect(parseRuntimeCliArgs(['setup'])).toEqual({
      command: 'setup',
      args: { yes: false, json: false },
    });
    expect(
      parseRuntimeCliArgs(['setup', '--profile', 'readonly', '--allow', 'shell=true', '--yes'])
    ).toEqual({
      command: 'setup',
      args: { profile: 'readonly', allow: { shell: true }, yes: true, json: false },
    });
    expect(parseRuntimeCliArgs(['setup', '--profile', 'none', '--json'])).toEqual({
      command: 'setup',
      args: { profile: 'none', yes: false, json: true },
    });
    expect(
      parseRuntimeCliArgs(['setup', '--slot', 'remote', '--profile', 'readonly', '--yes'])
    ).toEqual({
      command: 'setup',
      args: { slot: 'remote', profile: 'readonly', yes: true, json: false },
    });
    expect(parseRuntimeCliArgs(['setup', '--audit', 'on', '--yes'])).toEqual({
      command: 'setup',
      args: { audit: true, yes: true, json: false },
    });
  });

  it('parses audit filters', () => {
    expect(parseRuntimeCliArgs(['audit', '--denied', '--json'])).toEqual({
      command: 'audit',
      args: { denied: true, json: true },
    });
    expect(parseRuntimeCliArgs(['audit', '--since', '24h', '--slot', 'remote'])).toMatchObject({
      command: 'audit',
      args: { denied: false, json: false, slot: 'remote' },
    });
    expect(parseRuntimeCliArgs(['audit', '--since', 'nope'])).toMatchObject({
      command: 'invalid',
    });
  });

  it('says why a slot cannot be acted on, and what a slot is', () => {
    const invalid = parseRuntimeCliArgs(['setup', '--slot', 'ssh']);
    expect(invalid).toMatchObject({ command: 'invalid' });
    // "ssh" is the transport somebody reached for; the message has to say that
    // a slot is not one, or the next guess is "websocket".
    expect(invalid).toHaveProperty('reason', expect.stringContaining('ssh'));
    expect(invalid).toHaveProperty('reason', expect.stringContaining('not how a hub reaches it'));
  });

  it('says why a profile or an override cannot be acted on', () => {
    // A flag that exists given a value it cannot take is a different failure
    // from a flag nobody has heard of, and only one of them has a fix.
    const profile = parseRuntimeCliArgs(['setup', '--profile', 'custom']);
    expect(profile).toMatchObject({ command: 'invalid' });
    expect(profile).toHaveProperty('reason', expect.stringContaining('custom'));

    const allow = parseRuntimeCliArgs(['setup', '--allow', 'telepathy=true']);
    expect(allow).toMatchObject({ command: 'invalid' });
    expect(allow).toHaveProperty('reason', expect.stringContaining('telepathy'));
  });

  it('parses service install with mode and json status', () => {
    expect(parseRuntimeCliArgs(['service', 'install', '--mode', 'connect'])).toEqual({
      command: 'service',
      args: { action: 'install', mode: 'connect', json: false },
    });
    expect(parseRuntimeCliArgs(['service', 'status', '--json'])).toEqual({
      command: 'service',
      args: { action: 'status', json: true },
    });
  });

  // `install` and `service install` are different commands one word apart, and
  // the slot install defaults to the one a downloaded binary belongs to.
  it('parses install, defaulting to the remote slot', () => {
    expect(parseRuntimeCliArgs(['install'])).toEqual({
      command: 'install',
      args: { slot: 'remote', json: false },
    });
    expect(parseRuntimeCliArgs(['install', '--slot', 'host', '--json'])).toEqual({
      command: 'install',
      args: { slot: 'host', json: true },
    });
    expect(parseRuntimeCliArgs(['install', '--slot', 'nowhere'])).toMatchObject({
      command: 'invalid',
    });
    expect(parseRuntimeCliArgs(['install', '--mode', 'connect'])).toEqual({
      command: 'unknown',
      argument: '--mode',
    });
  });

  it('parses health and doctor with their one flag', () => {
    expect(parseRuntimeCliArgs(['health'])).toEqual({ command: 'health', args: { json: false } });
    expect(parseRuntimeCliArgs(['doctor', '--json'])).toEqual({
      command: 'doctor',
      args: { json: true },
    });
    expect(parseRuntimeCliArgs(['health', '--verbose'])).toEqual({
      command: 'unknown',
      argument: '--verbose',
    });
  });
});

describe('mangostudio-runtime binary', () => {
  it(
    'prints the stamped version',
    async () => {
      const run = await runCli(['--version']);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toBe('9.9.9-test');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'prints usage for a bare invocation',
    async () => {
      const run = await runCli([]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(RUNTIME_CLI_USAGE);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'exits non-zero and explains an unknown argument',
    async () => {
      const run = await runCli(['--serve']);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('Unknown argument: --serve');
      expect(run.stdout).toBe('');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'says what was wrong with a value rather than calling the flag unknown',
    async () => {
      const run = await runCli(['setup', '--profile', 'everything']);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('--profile takes full, readonly, or none');
      expect(run.stderr).not.toContain('Unknown argument');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'answers setup, health, and doctor without a terminal to prompt at',
    async () => {
      const home = await isolatedHome();
      const env = { MANGO_HOME: home };

      const setup = await runCli(['setup', '--profile', 'readonly', '--yes', '--json'], { env });
      expect(setup.exitCode).toBe(0);
      expect((JSON.parse(setup.stdout) as { profile: string }).profile).toBe('readonly');

      const health = await runCli(['health', '--json'], { env });
      const report = JSON.parse(health.stdout) as {
        slot: string;
        allow: Record<string, boolean>;
      };
      expect(report.slot).toBe('host');
      expect(report.allow.shell).toBe(false);

      const doctor = await runCli(['doctor'], { env });
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain('Consent');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'takes an image build answer from the environment',
    async () => {
      const home = await isolatedHome();
      const env = { MANGO_HOME: home, MANGOSTUDIO_RUNTIME_SETUP: 'full' };

      expect((await runCli(['setup', '--yes'], { env })).exitCode).toBe(0);
      const health = await runCli(['health', '--json'], { env });
      expect((JSON.parse(health.stdout) as { profile: string }).profile).toBe('full');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'refuses --stdio on a pending slot without writing a single byte to stdout',
    async () => {
      // The contract 013's stderr classifier and every stdio launcher depend on:
      // a refusal exits non-zero carrying the signature, and stdout stays empty.
      // One frame written before the refusal would leave the hub decoding a
      // stream that is never going to answer, and it would wait out its
      // handshake timeout instead of reporting a consent gate.
      const home = await isolatedHome();
      await Bun.write(
        join(home, 'runtime/host/runtime.json'),
        JSON.stringify({ schemaVersion: 1, slot: 'host', setup: { state: 'pending' } })
      );

      const run = await runCli(['--stdio'], { env: { MANGO_HOME: home } });
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('runtime setup is pending on this machine');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'serves a host slot with no setup step at all, which is what an image relies on',
    async () => {
      // The standing regression guard for containers: the runtime the Docker
      // image ships is the `host` slot, and a `host` slot with no config is
      // consented by the install that put it there.
      const run = await runCli(['doctor', '--json']);
      const payload = JSON.parse(run.stdout) as {
        health: { profile: string; setup: { state: string } };
      };
      expect(run.exitCode).toBe(0);
      expect(payload.health.profile).toBe('full');
      expect(payload.health.setup.state).toBe('configured');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'serves a handshake and a request over its pipes, then exits on EOF',
    async () => {
      const peer = launchStdioRuntime([CLI_ENTRY, '--stdio'], {
        env: { VERSION: '9.9.9-test' },
      });
      const session = hubSession(peer);

      try {
        const remote = await session.ready;
        expect(remote.peer).toMatchObject({ name: 'mangostudio-runtime', version: '9.9.9-test' });
        const manifest = remote.capabilities as unknown as RuntimeCapabilityManifest;
        expect(manifest.pathStyle).toBe(process.platform === 'win32' ? 'win32' : 'posix');

        // A real contract call, not a ping: it proves the handlers are behind
        // the gate and answering on the same pipe the handshake crossed.
        const health = (await session.request('runtime.health', {})) as RuntimeHealthReport;
        expect(health.runtimeVersion).toBe('9.9.9-test');
      } finally {
        session.close(CLOSE_CODES.RELEASED, 'test finished');
      }

      expect(await peer.exited).toEqual({ code: 0, signal: null });
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'exits non-zero and says why when the hub sends a record it cannot decode',
    async () => {
      // The stream cannot be resynchronised after a refused record, so the
      // session ends on one — and the hub reads stderr for the reason, since
      // stdout is the frame stream and has nothing left to say.
      const child = Bun.spawn({
        cmd: ['bun', CLI_ENTRY, '--stdio'],
        env: { ...process.env, VERSION: '9.9.9-test' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      child.stdin.write('not json\n');
      child.stdin.flush();

      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      // The hello, then a close naming the refusal, and nothing else: the
      // stream cannot carry an answer over a decoder that has lost its place.
      const written = stdout
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Frame);
      expect(written.map((frame) => frame.type)).toEqual(['hello', 'close']);
      expect(written[1]).toMatchObject({ code: CLOSE_CODES.PROTOCOL_ERROR });
      expect(stderr).toContain('line is not JSON');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'refuses a runtime that greets in the 1.0.1 framing instead of decoding it',
    async () => {
      // A runtime left over from before the protocol move writes a frame this
      // wire version has no reading of. The hub must not try: a hello it cannot
      // decode is 4426, and the child it started has to go with it.
      const peer = launchStdioRuntime(
        [
          '-e',
          `process.stdout.write(${JSON.stringify(LEGACY_HELLO_1_0_1_NDJSON_LINE)}); setInterval(() => {}, 1e6);`,
        ],
        // This child is meant to be signalled rather than to unwind, so the
        // reference graces would only make the test wait out both of them.
        { terminateGraceMs: 250, killGraceMs: 1_000 }
      );
      const session = hubSession(peer);

      const error = await rejectionOf(session.ready);
      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).code).toBe('PROTOCOL_MISMATCH');
      expect(session.closure?.code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);

      // Nothing ends a child that ignores end of stdin but the launcher, and a
      // refused handshake must not leave one behind. The status it ends with is
      // platform-shaped — POSIX names the signal, Windows only terminates — so
      // what is asserted is that it is not still the unstarted one.
      expect(peer.pid).toBeDefined();
      expect(await peer.terminate()).not.toEqual({ code: 0, signal: null });
    },
    SPAWN_TIMEOUT_MS
  );
});

interface StdioRuntimeOptions {
  readonly env?: Readonly<Record<string, string>>;
  /** Left at the SDK's reference graces unless a child is meant to be killed. */
  readonly terminateGraceMs?: number;
  readonly killGraceMs?: number;
}

/** Runs a child under the current Bun and speaks stdio through its pipes. */
function launchStdioRuntime(
  args: readonly string[],
  options: StdioRuntimeOptions = {}
): SpawnedPeer {
  return spawnPort({
    argv: [process.execPath, ...args],
    env: { ...inheritedEnv(), ...options.env },
    ...(options.terminateGraceMs !== undefined
      ? { terminateGraceMs: options.terminateGraceMs }
      : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
  });
}

/** The hub half of the handshake, announcing what a real hub announces. */
function hubSession(peer: SpawnedPeer): Session {
  return new Session(peer.port, {
    peer: { name: 'mangostudio', version: 'hub-test', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: 10_000,
  });
}

/** `process.env` without the holes, which the launcher's env does not accept. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
