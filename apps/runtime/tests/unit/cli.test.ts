import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeRuntimeFrame,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeFrame,
  RuntimeFrameDecoder,
} from '@mangostudio/shared/runtime-protocol';
import { parseRuntimeCliArgs, RUNTIME_CLI_USAGE } from '../../src/cli';

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

  it('requires --listen for serve', () => {
    expect(parseRuntimeCliArgs(['serve'])).toEqual({
      command: 'unknown',
      argument: '--listen',
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
      const child = Bun.spawn({
        cmd: ['bun', CLI_ENTRY, '--stdio'],
        env: { ...process.env, VERSION: '9.9.9-test' },
        stdin: 'pipe',
        stdout: 'pipe',
        // Inherited rather than piped: nothing here reads stderr, and a runtime
        // that logged more than the pipe buffer holds would block on the write
        // and hang this test until the spawn timeout.
        stderr: 'inherit',
      });

      const decoder = new RuntimeFrameDecoder();
      const pending: RuntimeFrame[] = [];
      const reader = child.stdout.getReader();
      const nextFrame = async (): Promise<RuntimeFrame> => {
        while (pending.length === 0) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Runtime closed stdout before answering.');
          pending.push(...decoder.push(value));
        }
        return pending.shift() as RuntimeFrame;
      };
      const write = (frame: RuntimeFrame): void => {
        child.stdin.write(encodeRuntimeFrame(frame));
        child.stdin.flush();
      };

      try {
        const hello = await nextFrame();
        expect(hello).toMatchObject({
          type: 'hello',
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          runtimeVersion: '9.9.9-test',
        });
        expect((hello as { manifest: { pathStyle: string } }).manifest.pathStyle).toBe(
          process.platform === 'win32' ? 'win32' : 'posix'
        );

        write({
          type: 'hello_ack',
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          hubVersion: 'hub-test',
        });
        write({ type: 'ping' });
        expect(await nextFrame()).toEqual({ type: 'pong' });

        write({ type: 'req', id: 'r1', method: 'workspace.validate', params: { path: '' } });
        expect(await nextFrame()).toMatchObject({ type: 'res', id: 'r1' });
      } finally {
        child.stdin.end();
      }

      expect(await child.exited).toBe(0);
    },
    SPAWN_TIMEOUT_MS
  );
});
