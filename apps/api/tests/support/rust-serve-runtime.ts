/**
 * One compiled `mangostudio-runtime serve` on a loopback port, under a scratch
 * `MANGO_HOME` and a scratch `HOME`, answered only for one bearer token.
 *
 * Readiness is the listener's own `GET /health`, so a caller that must see the
 * token refused (rather than the port not yet bound) can dial once and trust
 * the answer. The scratch `HOME` gives the binary a credential home that
 * certainly resolves, so it attests `os-account` (or `container`) the same way
 * on every machine.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizedEnv } from '@mangostudio/protocol/spawn';
import { cleanupMangoHome, scratchMangoHome } from './rust-runtime-binary';
import { reserveEphemeralPort } from './rust-serve-dial';

export interface RustServeRuntime {
  readonly port: number;
  /** `http://127.0.0.1:<port>`, the `baseUrl` of an `http` environment. */
  readonly baseUrl: string;
  /** `ws://127.0.0.1:<port>`, for a test that dials the socket itself. */
  readonly wsUrl: string;
  /** The scratch `MANGO_HOME`, e.g. for `setup --slot remote`. */
  readonly mangoHome: string;
  /** Stops the child and removes both scratch directories. */
  close(): Promise<void>;
}

export interface StartRustServeOptions {
  readonly label: string;
  readonly token: string;
  /** Runs against the scratch `MANGO_HOME` before `serve` starts, e.g. to grant consent. */
  readonly prepare?: (mangoHome: string) => Promise<void>;
  readonly readyTimeoutMs?: number;
}

/**
 * Spawns `serve` and resolves once its listener answers `GET /health`.
 *
 * @example
 * const serve = await startRustServe(binary.path, { label: 'rotation', token: 'secret' });
 * try { await connectHttpRuntime(...); } finally { await serve.close(); }
 */
export async function startRustServe(
  binaryPath: string,
  options: StartRustServeOptions
): Promise<RustServeRuntime> {
  const scratch = await scratchMangoHome(options.label);
  const mangoHome = join(scratch, 'mango');
  const home = join(scratch, 'home');
  await mkdir(mangoHome, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    await options.prepare?.(mangoHome);
  } catch (error) {
    await cleanupMangoHome(scratch);
    throw error;
  }

  const port = reserveEphemeralPort();
  const child = Bun.spawn({
    cmd: [binaryPath, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
    env: {
      ...sanitizedEnv(process.env, { MANGO_HOME: mangoHome }),
      MANGOSTUDIO_RUNTIME_SERVE_TOKEN: options.token,
      HOME: home,
      USERPROFILE: home,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // Drained from the start so a chatty child never blocks on a full pipe;
  // read back only to explain an early exit.
  const stderr = new Response(child.stderr).text();
  const close = async (): Promise<void> => {
    child.kill();
    await child.exited;
    await cleanupMangoHome(scratch);
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child, stderr, options.readyTimeoutMs ?? 10_000);
  } catch (error) {
    await close();
    throw error;
  }
  return { port, baseUrl, wsUrl: `ws://127.0.0.1:${port}`, mangoHome, close };
}

async function waitForHealth(
  baseUrl: string,
  child: { readonly exitCode: number | null },
  stderr: Promise<string>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `expected "serve" to keep listening on ${baseUrl} | received: exit ${child.exitCode}: ${await stderr}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `expected "serve" to answer GET ${baseUrl}/health within ${timeoutMs}ms | received: ${last}`
  );
}
