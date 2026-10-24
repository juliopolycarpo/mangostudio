/**
 * A controlled, harmless "package manager" for qualifying `install.run` and
 * `install.cancel` against the real Rust runtime through the Hub's own
 * install relay — never a real package-manager mutation.
 *
 * Each fake installer's only effect is appending one line to a marker file
 * inside a scratch directory, so a test can prove the effect happened exactly
 * once. Paths use UTF-8 data, POSIX quoting or CMD script-relative names,
 * because the runtime forwards only its install allowlist rather than fixture env data.
 *
 * On Windows the fake installer is a PowerShell `-File` script by default,
 * because every Windows recipe runs `powershell`; a `cmd.exe` batch file is
 * available as an extra interpreter case.
 */

import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createInstallRunner } from '../../src/modules/environments/infrastructure/install-runner';
import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import type { FakeInstaller } from './controlled-installer';
import { waitUntil } from './wait-until';

export type { FakeInstaller } from './controlled-installer';
export { writeFakeInstaller } from './controlled-installer';
export { waitUntil };

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
  let lines: string[] = [];
  let lastRead = 'the marker does not exist yet';
  // The marker appears before the installer has finished writing it, and on Windows reading it while
  // the writer still holds it open fails with EBUSY. Wait for a complete line instead of existence.
  await waitUntil(
    () => {
      try {
        const text = readFileSync(installer.marker, 'utf8');
        lines = text.split(/\r?\n/).filter(Boolean);
        lastRead = JSON.stringify(text);
        return text.endsWith('\n');
      } catch (error) {
        // Not created yet, or still held open by the writer (Windows sharing violation).
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EBUSY') throw error;
        lastRead = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    'the installer effect',
    10_000,
    () => [run?.describe(), `last marker read: ${lastRead}`].filter(Boolean).join('; ')
  );
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
