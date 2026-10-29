import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { SmokeHub } from './binary-smoke-hub';
import { artifactSmokeEnvironment, awaitSmokeCompletion } from './binary-smoke-process';
import {
  probeRuntimeHandshake,
  type RuntimeHandshakeChild,
  type RuntimeHandshakeProbe,
} from './runtime-handshake';

/**
 * Probe a copied runtime outside the checkout, settling owned processes and pipes before removal.
 * @example const result = await probeIsolatedRuntime(runtimePath, checkout);
 */
export async function probeIsolatedRuntime(
  binaryPath: string,
  checkout: string,
  source: NodeJS.ProcessEnv = process.env,
  options: { budgetMs?: number } = {}
): Promise<{ version: string; versionExit: number; probe: RuntimeHandshakeProbe }> {
  const home = mkdtempSync(join(tmpdir(), 'mangostudio-runtime-smoke-'));
  const staged = join(home, basename(binaryPath));
  const env = artifactSmokeEnvironment(source, home, checkout);
  const budgetMs = options.budgetMs ?? 30_000;
  const lifetime = { settled: true };
  try {
    copyFileSync(binaryPath, staged);
    const version = await withRuntimeChild(
      [staged, '--version'],
      home,
      env,
      budgetMs,
      lifetime,
      async (child) => {
        await child.stdin.end();
        const [text, , exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { text: text.trim(), exitCode };
      }
    );
    const handshake = await withRuntimeChild(
      [staged, '--stdio'],
      home,
      env,
      budgetMs,
      lifetime,
      (child) =>
        probeRuntimeHandshake({
          command: [staged, '--stdio'],
          // Ownership and bounded shutdown belong to withRuntimeChild, including descendants.
          spawn: () => ({
            ...child,
            get exitCode() {
              return child.exitCode;
            },
            get signalCode() {
              return child.signalCode;
            },
            stdin: {
              end() {
                /* The owner keeps stdin open until the final census. */
              },
            },
            kill() {
              /* The owner signals the verified process scope after the probe. */
            },
          }),
          exitGraceMs: 0,
        })
    );
    return {
      version: version.value.text,
      versionExit: version.value.exitCode,
      probe: { ...handshake.value, stderr: handshake.stderr },
    };
  } finally {
    if (lifetime.settled) rmSync(home, { recursive: true, force: true });
  }
}

async function withRuntimeChild<T>(
  command: string[],
  home: string,
  env: Record<string, string>,
  budgetMs: number,
  lifetime: { settled: boolean },
  action: (child: RuntimeHandshakeChild) => Promise<T>
): Promise<{ value: T; stderr: string }> {
  let actionChild: RuntimeHandshakeChild | undefined;
  let output: Promise<string> | undefined;
  const owner = new SmokeHub({
    budgetMs,
    requireExitZero: false,
    spawn: () => {
      const child = Bun.spawn({
        cmd: command,
        cwd: home,
        env,
        detached: process.platform !== 'win32',
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      lifetime.settled = false;
      const [stdout, complete] = child.stdout.tee();
      const [stderr, diagnostics] = child.stderr.tee();
      output = new Response(complete).text();
      actionChild = {
        stdout,
        stderr,
        stdin: child.stdin,
        exited: child.exited,
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        kill: () => child.kill(),
      };
      return {
        pid: child.pid,
        stderr: diagnostics,
        exited: child.exited,
        get exitCode() {
          return child.exitCode;
        },
        kill: (signal) => child.kill(signal),
      };
    },
    ready: () => Promise.resolve(),
  });
  let value: T;
  try {
    await owner.start();
    if (!actionChild) throw new Error('runtime probe: expected spawned process handle');
    value = await awaitSmokeCompletion(action(actionChild), 90_000, 'runtime probe');
  } finally {
    try {
      await owner.stop();
    } finally {
      await awaitSmokeCompletion(output ?? Promise.resolve(''), budgetMs, 'runtime stdout drain');
    }
    lifetime.settled = true;
  }
  return { value, stderr: owner.errorText() };
}
