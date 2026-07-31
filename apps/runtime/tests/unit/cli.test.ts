import { describe, expect, it } from 'bun:test';
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

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[], version = '9.9.9-test'): Promise<CliRun> {
  const child = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    env: { ...process.env, VERSION: version },
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
