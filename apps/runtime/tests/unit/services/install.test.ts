import { describe, expect, it } from 'bun:test';
import type { RuntimeEventInput } from '../../../src/host';
import type { RuntimeInstallOutputEvent } from '../../../src/methods';
import { buildInstallEnvironment, createInstallService } from '../../../src/services/install';

interface InstallLogLine {
  readonly stream: RuntimeInstallOutputEvent['stream'];
  readonly line: string;
}

class FakeInstallProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  exitCode: number | null = null;
  killedWith: string | null = null;
  private resolveExit!: (code: number) => void;

  constructor(stdout: string, stderr: string, exitCode?: number) {
    this.stdout = streamFrom(stdout);
    this.stderr = streamFrom(stderr);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    if (exitCode !== undefined) {
      queueMicrotask(() => this.finish(exitCode));
    }
  }

  kill(signal: 'SIGKILL'): void {
    this.killedWith = signal;
    this.finish(137);
  }

  private finish(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.resolveExit(code);
  }
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Collects the lines the service publishes, dropping the terminal marker. */
function collector() {
  const events: InstallLogLine[] = [];
  const emit = (event: RuntimeEventInput) => {
    const payload = event.payload as RuntimeInstallOutputEvent;
    if (payload.end) return;
    events.push({ stream: payload.stream, line: payload.line });
  };
  return { events, emit };
}

function createRunner(
  process: FakeInstallProcess,
  captured: { log: Uint8Array[] },
  emit: (event: RuntimeEventInput) => void = () => undefined
) {
  return createInstallService({
    emit,
    deps: {
      spawn: () => process,
      prepareLog: () => Promise.resolve(),
      appendLog: (_path, bytes) => {
        captured.log.push(bytes);
        return Promise.resolve();
      },
    },
  });
}

const COMMAND = {
  runId: 'run-1',
  argv: ['echo', 'hello'],
  timeoutMs: 1000,
  logPath: '/tmp/install.log',
} as const;

describe('runtime install execution', () => {
  it('passes only allowlisted environment keys plus constant recipe overrides', () => {
    const env = buildInstallEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/tester',
        XDG_CONFIG_HOME: '/home/tester/.config',
        HTTPS_PROXY: 'https://proxy.test',
        ANTHROPIC_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
      },
      {
        PROFILE: '/dev/null',
        NVM_DIR: '/home/tester/.nvm',
        ANTHROPIC_API_KEY: 'still-secret',
      }
    );

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/tester',
      XDG_CONFIG_HOME: '/home/tester/.config',
      HTTPS_PROXY: 'https://proxy.test',
      PROFILE: '/dev/null',
      NVM_DIR: '/home/tester/.nvm',
    });
  });

  it('accepts CODEX_NON_INTERACTIVE and FNM_DIR as constant recipe overrides', () => {
    const env = buildInstallEnvironment(
      { PATH: '/bin' },
      { CODEX_NON_INTERACTIVE: '1', FNM_DIR: '/home/tester/.fnm', ANTHROPIC_API_KEY: 'secret' }
    );

    expect(env).toEqual({ PATH: '/bin', CODEX_NON_INTERACTIVE: '1', FNM_DIR: '/home/tester/.fnm' });
  });

  it('forwards the win32-only keys PowerShell and its installers need, only on win32', () => {
    const source = {
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.EXE;.BAT',
      SystemDrive: 'C:',
      USERPROFILE: 'C:\\Users\\tester',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    };

    const win32Env = buildInstallEnvironment(source, {}, 'win32');
    expect(win32Env).toEqual(source);

    const posixEnv = buildInstallEnvironment(source, {}, 'linux');
    expect(posixEnv).toEqual({ PATH: 'C:\\bin' });
  });

  it('streams lines, writes a bounded raw log, and records success', async () => {
    const process = new FakeInstallProcess('hello\nworld\n', 'warning\n', 0);
    const captured = { log: [] as Uint8Array[] };
    const { events, emit } = collector();
    const runner = createRunner(process, captured, emit);

    const result = await runner.run(COMMAND);

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(events).toEqual([
      { stream: 'stdout', line: 'hello' },
      { stream: 'stdout', line: 'world' },
      { stream: 'stderr', line: 'warning' },
    ]);
    expect(
      new TextDecoder().decode(Uint8Array.from(captured.log.flatMap((chunk) => [...chunk])))
    ).toBe('hello\nworld\nwarning\n');
  });

  it('treats an accepted non-zero exit code as success', async () => {
    // winget's own "no applicable update found" — a package already at the
    // version it would install exits with this instead of 0.
    const WINGET_NO_APPLICABLE_UPGRADE = -1978335189;
    const process = new FakeInstallProcess('', '', WINGET_NO_APPLICABLE_UPGRADE);
    const runner = createRunner(process, { log: [] });

    const result = await runner.run({
      ...COMMAND,
      acceptedExitCodes: [WINGET_NO_APPLICABLE_UPGRADE],
    });

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(WINGET_NO_APPLICABLE_UPGRADE);
  });

  it('still fails a non-zero exit code the recipe did not accept', async () => {
    const process = new FakeInstallProcess('', '', 1);
    const runner = createRunner(process, { log: [] });

    const result = await runner.run({ ...COMMAND, acceptedExitCodes: [-1978335189] });

    expect(result.status).toBe('failed');
  });

  it("matches an accepted exit code by bit pattern, not sign — a platform that reports the process's exit code unsigned still matches a recipe's signed constant", async () => {
    // -1978335189 and 2316632107 are the same 32-bit pattern (0x8A15002B).
    const process = new FakeInstallProcess('', '', 2316632107);
    const runner = createRunner(process, { log: [] });

    const result = await runner.run({ ...COMMAND, acceptedExitCodes: [-1978335189] });

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(2316632107);
  });

  it('caps captured output while continuing to a terminal result', async () => {
    const process = new FakeInstallProcess('0123456789', '', 0);
    const captured = { log: [] as Uint8Array[] };
    const { events, emit } = collector();
    const runner = createRunner(process, captured, emit);

    const result = await runner.run({ ...COMMAND, outputLimitBytes: 4 });

    expect(result.truncated).toBe(true);
    expect(captured.log.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(4);
    expect(events).toContainEqual({
      stream: 'system',
      line: 'Output truncated after 4 bytes.',
    });
  });

  it('kills a timed-out child with SIGKILL', async () => {
    const timedOut = new FakeInstallProcess('', '');
    const result = await createRunner(timedOut, { log: [] }).run({ ...COMMAND, timeoutMs: 1 });

    expect(result.status).toBe('timed-out');
    expect(timedOut.killedWith).toBe('SIGKILL');
  });

  it('kills a child the hub asked it to cancel', async () => {
    const cancelled = new FakeInstallProcess('', '');
    const service = createRunner(cancelled, { log: [] });
    const running = service.run(COMMAND);
    await Promise.resolve();

    await service.cancel({ runId: COMMAND.runId });
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(cancelled.killedWith).toBe('SIGKILL');
  });

  it('accepts a cancel for a run it no longer holds rather than failing', async () => {
    const service = createRunner(new FakeInstallProcess('', '', 0), { log: [] });

    await expect(service.cancel({ runId: 'never-started' })).resolves.toEqual({ ok: true });
  });

  it('ends the output stream so the hub stops waiting for frames', async () => {
    const ended: RuntimeEventInput[] = [];
    const service = createRunner(new FakeInstallProcess('done\n', '', 0), { log: [] }, (event) => {
      if ((event.payload as RuntimeInstallOutputEvent).end) ended.push(event);
    });

    await service.run(COMMAND);

    expect(ended).toHaveLength(1);
    expect(ended[0]?.streamId).toBe(COMMAND.runId);
    expect(ended[0]?.end).toBe(true);
  });

  it('reports a synchronous spawn failure without throwing', async () => {
    const { events, emit } = collector();
    const runner = createInstallService({
      emit,
      deps: {
        spawn: () => {
          throw new Error('binary missing');
        },
        prepareLog: () => Promise.resolve(),
      },
    });

    const result = await runner.run(COMMAND);

    expect(result.status).toBe('spawn-failed');
    expect(result.exitCode).toBeNull();
    expect(events).toEqual([{ stream: 'system', line: 'binary missing' }]);
  });
});
