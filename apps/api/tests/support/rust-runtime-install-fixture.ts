/**
 * A controlled, harmless "package manager" for qualifying `install.run` and
 * `install.cancel` against the real Rust runtime through the Hub's own
 * install relay — never a real package-manager mutation.
 *
 * Each fake installer's only effect is appending one line to a marker file
 * inside a scratch directory, so a test can prove the effect happened exactly
 * once. Paths are written into the script text rather than passed through the
 * environment, because the runtime forwards only its install allowlist.
 *
 * On Windows the fake installer is a PowerShell `-File` script by default,
 * because every Windows recipe runs `powershell`; a `cmd.exe` batch file is
 * available as an extra interpreter case.
 */

import { expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInstallRunner } from '../../src/modules/environments/infrastructure/install-runner';
import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';

export interface FakeInstaller {
  /** The hub-built argv the runtime launches. */
  readonly argv: readonly string[];
  /** Appended once when the fake installer applies its effect. */
  readonly marker: string;
  /** Created by the test to let a `waits` installer finish. */
  readonly release: string;
  /** Where the runtime writes this run's raw log (absolute, so never the real home). */
  readonly logPath: string;
  /** Written by a `grandchild` installer with the pid of its backgrounded child. */
  readonly pidFile: string;
}

/**
 * What the fake installer does after printing `waiting` (stdout) and `warn` (stderr):
 * - `waits`: blocks until the release file exists, then applies its effect;
 * - `sleeps`: applies its effect after one second, needing no further input;
 * - `grandchild`: backgrounds a long sleep, records its pid, and never finishes (POSIX only).
 */
export type FakeInstallerMode = 'waits' | 'sleeps' | 'grandchild';

/** The Windows interpreter; recipes use `powershell`, `cmd` is an extra control case. */
export type WindowsInterpreter = 'powershell' | 'cmd';

const isWindows = process.platform === 'win32';

/**
 * Writes one fake installer into `directory`.
 *
 * @example
 * const installer = await writeFakeInstaller(scratch, 'waits', 'run-1');
 */
export async function writeFakeInstaller(
  directory: string,
  mode: FakeInstallerMode,
  name: string,
  interpreter: WindowsInterpreter = 'powershell'
): Promise<FakeInstaller> {
  const marker = join(directory, `${name}.marker`);
  const release = join(directory, `${name}.release`);
  const pidFile = join(directory, `${name}.pid`);
  const logPath = join(directory, `${name}.log`);
  if (isWindows && interpreter === 'powershell') {
    if (mode === 'grandchild') throw new Error('The grandchild installer is POSIX-only.');
    const script = join(directory, `${name}.ps1`);
    const wait =
      mode === 'waits'
        ? `while (-not (Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
        : 'Start-Sleep -Seconds 1';
    await writeFile(
      script,
      [
        "Write-Output 'waiting'",
        "[Console]::Error.WriteLine('warn')",
        wait,
        `Add-Content -LiteralPath '${marker}' -Value 'run'`,
        "Write-Output 'done'",
        '',
      ].join('\r\n')
    );
    // The recipes' own POWERSHELL_ARGV_PREFIX shape, ending in `-File`.
    return {
      argv: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
      ],
      marker,
      release,
      logPath,
      pidFile,
    };
  }
  if (isWindows) {
    if (mode === 'grandchild') throw new Error('The grandchild installer is POSIX-only.');
    const script = join(directory, `${name}.cmd`);
    // `ping -n 2` to loopback is cmd's portable one-second sleep; `timeout.exe`
    // refuses to run without console input.
    const wait =
      mode === 'waits'
        ? [':wait', `if exist "${release}" goto go`, 'ping -n 2 127.0.0.1 >nul', 'goto wait', ':go']
        : ['ping -n 2 127.0.0.1 >nul'];
    await writeFile(
      script,
      [
        '@echo off',
        'echo waiting',
        '1>&2 echo warn',
        ...wait,
        `echo run>>"${marker}"`,
        'echo done',
        'exit /b 0',
        '',
      ].join('\r\n')
    );
    return { argv: ['cmd.exe', '/d', '/c', script], marker, release, logPath, pidFile };
  }
  const script = join(directory, `${name}.sh`);
  const body: Record<FakeInstallerMode, string> = {
    waits: `while [ ! -e '${release}' ]; do sleep 0.05; done; echo run >> '${marker}'; echo done`,
    sleeps: `sleep 1; echo run >> '${marker}'; echo done`,
    grandchild: `sleep 30 & echo $! > '${pidFile}'; wait`,
  };
  await writeFile(script, `echo waiting\necho warn >&2\n${body[mode]}\n`);
  return { argv: ['sh', script], marker, release, logPath, pidFile };
}

/** One run's relayed output, as the Hub's install service receives it. */
export interface RelayedInstall {
  readonly lines: Array<{ readonly stream: string; readonly line: string }>;
  /** Everything relayed so far plus the run's status and exit code, for failure messages. */
  describe(): string;
  readonly result: ReturnType<ReturnType<typeof createInstallRunner>['run']>;
  /** Resolves once a relayed line on `stream` contains `text`. */
  waitForLine(stream: string, text: string, timeoutMs?: number): Promise<void>;
}

/**
 * Starts one install through the Hub's real relay (`createInstallRunner`)
 * against `client`, with the log kept beside the fake installer.
 *
 * @example
 * const run = startRelayedInstall(client, installer, { runId: 'run-1', signal });
 * await run.waitForLine('stdout', 'waiting');
 */
export function startRelayedInstall(
  client: RuntimeClient,
  installer: FakeInstaller,
  options: { readonly runId: string; readonly signal?: AbortSignal; readonly timeoutMs?: number }
): RelayedInstall {
  const lines: Array<{ stream: string; line: string }> = [];
  const runner = createInstallRunner({
    resolveClient: () => Promise.resolve(client),
    logPathFor: () => installer.logPath,
  });
  const result = runner.run(
    {
      runId: options.runId,
      userId: 'rust-install-qualification',
      environmentId: 'rust-install-qualification',
      argv: installer.argv,
      timeoutMs: options.timeoutMs ?? 20_000,
    },
    { signal: options.signal, onLog: (event) => lines.push(event) }
  );
  let settled: unknown = 'pending';
  result.then(
    (value) => {
      settled = value;
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
  );
  const describe = () =>
    `installer argv=${JSON.stringify(installer.argv)}; relayed lines (stdout, stderr and the ` +
    `runtime's system lines)=${JSON.stringify(lines)}; run result (status, exitCode)=` +
    `${JSON.stringify(settled)}`;
  return {
    lines,
    result,
    describe,
    waitForLine: (stream, text, timeoutMs = 20_000) =>
      waitUntil(
        () => lines.some((entry) => entry.stream === stream && entry.line.includes(text)),
        `a relayed ${stream} line containing "${text}"`,
        timeoutMs,
        describe
      ),
  };
}

/**
 * Polls `condition` until it holds, failing with what was expected.
 *
 * @example
 * await waitUntil(() => existsSync(marker), 'the installer marker');
 */
export async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
  context?: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      const detail = context ? `; ${context()}` : '';
      throw new Error(`expected ${what} | received: nothing within ${timeoutMs}ms${detail}`);
    }
    await Bun.sleep(20);
  }
}

/**
 * Asserts the fake installer applied its effect exactly once; `run`, when given,
 * explains a missing effect with what the run relayed and how it ended.
 *
 * @example
 * await expectAppliedOnce(installer, run);
 */
export async function expectAppliedOnce(
  installer: FakeInstaller,
  run?: Pick<RelayedInstall, 'describe'>
): Promise<void> {
  await waitUntil(
    () => existsSync(installer.marker),
    'the installer effect',
    10_000,
    run?.describe
  );
  const lines = (await readFile(installer.marker, 'utf8')).split(/\r?\n/).filter(Boolean);
  expect(lines).toEqual(['run']);
}

/**
 * Whether the process `pid` has exited, polling for up to `timeoutMs`.
 *
 * @example
 * expect(await processGone(pid)).toBe(true);
 */
export async function processGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}
