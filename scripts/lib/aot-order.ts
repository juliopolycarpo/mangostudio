/**
 * AOT function order for the compiled hub.
 *
 * `bun build --compile --aot --aot-record-order` writes a binary that, when run with
 * `BUN_AOT_ORDER_OUT=<file>`, records the order its functions first ran in. Compiling again with
 * `--aot-order=<file>` lays machine code out in that order, so the pages a hub touches while it
 * starts and serves its first requests sit next to each other and the rest stay unread. On
 * linux-x64 that took the hub's idle RSS from 69.2 to 59.6 MB with the same file size.
 *
 * The order file numbers functions by position in the bundled program, so it is only good for the
 * program it was recorded from: an edit that adds or removes a function shifts every later index.
 * Bun does not warn about that (it accepts any well-formed file), and it ignores a malformed one
 * with a warning that a green build hides. So the build records a fresh file from the exact binary
 * it is about to compile, and checks the file's shape itself.
 *
 * Bun documents recording as Linux-only, and the pre-read it pairs with as Linux-only too.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  createIsolatedHubHome,
  guardIsolatedHub,
  isolatedHubEnv,
  ownsServerState,
  removeIsolatedHubHome,
  reserveEphemeralPort,
} from './hub-process';
import { runHubWorkload } from './hub-workload';

/** The first line of an order file Bun accepts. */
const ORDER_FILE_HEADER = 'aot-order v1';

/** Ceiling for the whole recording run: start, workload, exit and file write. */
const RECORDING_DEADLINE_MS = 120_000;
const EXIT_DEADLINE_MS = 30_000;

/** Compiler flag that makes a binary write its order file when run. */
export const AOT_RECORD_ORDER_FLAG = '--aot-record-order';

/** Compiler flag that lays a binary out by an order file. Example: aotOrderFlag('/tmp/hub.order') */
export function aotOrderFlag(orderFile: string): string {
  return `--aot-order=${orderFile}`;
}

/**
 * Why a build does not record an order, or `null` when it does. Recording costs a second compile
 * and a hub run (about 100 MB of scratch files), so a build asks for it: `--production` or
 * `--require-aot-order`, not a plain local, smoke or test build. A native build runs on its own
 * target, so it can run the binary it records; Bun can only record on Linux, and the bytecode
 * fallback is not an AOT build at all.
 * Example: aotOrderSkipReason('native', 'darwin', true) // 'Bun records AOT function order on Linux only (host: darwin)'
 */
export function aotOrderSkipReason(
  compiler: string,
  hostPlatform: string,
  requested: boolean
): string | null {
  if (!requested) {
    return 'not requested (pass --production or --require-aot-order to record it)';
  }
  if (compiler !== 'native') {
    return `--compiler ${compiler} is not a native AOT build, so there is no function order to lay out`;
  }
  if (hostPlatform !== 'linux') {
    return `Bun records AOT function order on Linux only (host: ${hostPlatform})`;
  }
  return null;
}

/** What an order file says about itself. */
export interface AotOrderSummary {
  /** Number of `F` lines: the functions the recorded run executed. */
  readonly functionCount: number;
}

/**
 * Checks that `text` has the shape `--aot-order` reads and returns its summary. Throws, naming the
 * first line that is wrong, because Bun itself only warns and carries on without any order.
 * Example: parseAotOrder('aot-order v1\nP 39150\nF = 7066 b0 - 0:0 \n') // { functionCount: 1 }
 */
export function parseAotOrder(text: string): AotOrderSummary {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines[0] !== ORDER_FILE_HEADER) {
    throw new Error(
      `aot order: expected first line "${ORDER_FILE_HEADER}" | received: ${JSON.stringify(lines[0] ?? '')}`
    );
  }
  let functionCount = 0;
  for (const line of lines.slice(1)) {
    // `P <program size>`, `E <entry module>` (newer Bun) and `M <index> <module>` describe the program; `F ...` is one function.
    if (/^(?:P \d+|E \S+|M \d+ \S+)$/.test(line)) continue;
    if (/^F (?:=|\d+) \d+ \S+ \S+ \S+ ?$/.test(line)) {
      functionCount += 1;
      continue;
    }
    throw new Error(
      `aot order: expected a "P <n>", "E <entry>", "M <n> <module>" or "F <...>" line | received: ${JSON.stringify(line)}`
    );
  }
  if (functionCount === 0) {
    throw new Error(
      'aot order: expected at least one "F ..." line | received: none, so the run recorded no function'
    );
  }
  return { functionCount };
}

/**
 * Starts the ceiling on a whole recording run: calls `expire` after `ms` and returns the function
 * that cancels it. Replaceable so a test can fire it at a moment it chose instead of racing a
 * hub's start-up against a few hundred milliseconds.
 */
export type DeadlineTimer = (ms: number, expire: () => void) => () => void;

const setDeadlineTimer: DeadlineTimer = (ms, expire) => {
  const handle = setTimeout(expire, ms);
  return () => clearTimeout(handle);
};

/** Options of `recordAotOrder`; each is replaceable so a test can use a fake hub. */
export interface RecordAotOrderOptions {
  /** Requests sent to the recording hub once it is healthy. Defaults to the shared hub workload. */
  readonly workload?: (baseUrl: string) => Promise<unknown>;
  /** Ceiling for the whole run. Defaults to `RECORDING_DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** Starts that ceiling. Defaults to a `setTimeout`. */
  readonly setDeadline?: DeadlineTimer;
}

/**
 * Runs a `--aot-record-order` hub through the workload, stops it with SIGTERM so it writes its
 * order file, and returns the file's summary.
 *
 * The hub runs in a throwaway home inside the OS temp directory, on a loopback port the OS chose,
 * with an allowlisted environment (see `isolatedHubEnv`); the one path it is given outside that
 * home is the order file. It is detached in its own process group, so the group is adopted by a
 * `ChildSupervisor`: a SIGINT, SIGTERM or SIGHUP to the build stops the hub before the build exits,
 * and the home is deleted on exit. Whatever else happens, the group is killed and reaped and the
 * home deleted before this returns.
 *
 * A healthy answer is not trusted until the hub's own state file in that home names its pid and
 * port, because another process can take the port between its choice and the hub binding it.
 *
 * This hub starts with no `mangostudio-runtime` beside it, so the order covers the hub's start-up
 * and request paths, and a Local runtime launch that finds no binary (see the AOT section of
 * `docs/reference/runtime-metrics.md` for what a recorded runtime would add).
 * Example: await recordAotOrder('.mango/aot-order/linux-x64/record/mangostudio', '.mango/aot-order/linux-x64/hub.order')
 */
export async function recordAotOrder(
  recordingBinary: string,
  orderFile: string,
  options: RecordAotOrderOptions = {}
): Promise<AotOrderSummary> {
  const workload = options.workload ?? runHubWorkload;
  const deadlineMs = options.deadlineMs ?? RECORDING_DEADLINE_MS;
  const setDeadline = options.setDeadline ?? setDeadlineTimer;
  mkdirSync(dirname(orderFile), { recursive: true });
  rmSync(orderFile, { force: true });
  const home = createIsolatedHubHome();
  let hub: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  let releaseGuard: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  try {
    const port = await reserveEphemeralPort();
    const spawnedAt = Date.now();
    hub = Bun.spawn([recordingBinary, 'serve', String(port)], {
      env: { ...isolatedHubEnv(home, port), BUN_AOT_ORDER_OUT: orderFile },
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const running = hub;
    releaseGuard = guardIsolatedHub(running, home, 'AOT recording hub');
    const stderr = new Response(running.stderr).text();
    let progress = 'waiting for the hub to answer health';
    const run = (async (): Promise<AotOrderSummary> => {
      await waitForHealth(`http://127.0.0.1:${port}/api/health`, running, {
        home,
        port,
        spawnedAt,
        onProgress: (note) => {
          progress = note;
        },
      });
      progress = 'running the workload';
      await workload(`http://127.0.0.1:${port}`);
      progress = 'waiting for the hub to exit and write its order file';
      running.kill('SIGTERM');
      const exited = await Promise.race([
        running.exited,
        Bun.sleep(EXIT_DEADLINE_MS).then(() => 'timeout' as const),
      ]);
      if (exited === 'timeout') {
        throw new Error(
          `aot order: expected the recording hub to exit within ${EXIT_DEADLINE_MS} ms of SIGTERM | received: still running`
        );
      }
      if (!existsSync(orderFile)) {
        throw new Error(
          `aot order: expected the recording hub to write ${orderFile} on exit | received: no file (exit ${exited}). Hub stderr:\n${await stderr}`
        );
      }
      return parseAotOrder(readFileSync(orderFile, 'utf8'));
    })();
    // The deadline rejects while `run` may still be awaiting a request; the finally block below
    // kills the hub, which settles `run`, so its late rejection is expected and dropped.
    run.catch(() => undefined);
    const expired = new Promise<never>((_resolve, reject) => {
      cancelDeadline = setDeadline(deadlineMs, () => {
        reject(
          new Error(
            `aot order: expected the recording run to finish within ${deadlineMs} ms | received: still running (${progress})`
          )
        );
      });
    });
    return await Promise.race([run, expired]);
  } finally {
    cancelDeadline?.();
    if (hub) {
      try {
        process.kill(-hub.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
      await hub.exited;
    }
    releaseGuard?.();
    removeIsolatedHubHome(home);
  }
}

/** What `waitForHealth` needs to prove the healthy server is the hub this run spawned. */
interface HubIdentity {
  readonly home: string;
  readonly port: number;
  readonly spawnedAt: number;
  readonly onProgress: (note: string) => void;
}

async function waitForHealth(
  url: string,
  hub: Bun.Subprocess,
  identity: HubIdentity
): Promise<void> {
  while (hub.exitCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) {
        // Whatever answers on the port must be the hub we started, not a stranger that bound it
        // between `reserveEphemeralPort` and the hub's own bind.
        if (await ownsServerState(identity.home, hub.pid, identity.port, identity.spawnedAt))
          return;
        identity.onProgress(
          `${url} answered 200 but ${identity.home}/.mango/run/server.json does not name pid ${hub.pid} and port ${identity.port}, so the listener is not this hub`
        );
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `aot order: expected ${url} to answer 200 before the hub exited | received: hub exit ${hub.exitCode}`
  );
}

/** Result of one compiler invocation. */
export interface CompileOutcome {
  readonly ok: boolean;
  /** What the compiler printed, for the build log. */
  readonly stdout: string;
  /** What it wrote to stderr; where Bun reports an order file it could not use. */
  readonly stderr: string;
}

/** What `compileWithAotOrder` does around the compiler; each part is replaceable in tests. */
export interface AotOrderSteps {
  /** One compile of the hub with `extraFlags` appended, into `outfile`. */
  compile(extraFlags: readonly string[], outfile: string): Promise<CompileOutcome>;
  record(recordingBinary: string, orderFile: string): Promise<AotOrderSummary>;
  log(message: string): void;
  warn(message: string): void;
  /** Milliseconds clock. */
  now(): number;
}

/** Where and whether `compileWithAotOrder` records. */
export interface AotOrderPlan {
  /** Label for messages, e.g. the platform id. */
  readonly target: string;
  /** `aotOrderSkipReason(...)`: when set, the hub is compiled once without an order. */
  readonly skipReason: string | null;
  /** Fail the build when recording fails, instead of shipping a hub without an order. */
  readonly required: boolean;
  /** A directory only this build writes: the recording binary and the order file live here. */
  readonly orderDir: string;
  /** The binary name inside `orderDir`. */
  readonly binaryName: string;
}

/** Final result: the shipping compile's outcome, and what the build must record about the order. */
export interface AotOrderCompileResult extends CompileOutcome {
  /** Why no hub was produced, when none was. */
  readonly failure?: string;
  /** SHA-256 of the order file the shipping binary was laid out by; null when none was applied. */
  readonly orderSha256: string | null;
}

/**
 * The line Bun prints when it cannot use an `--aot-order` file, or null when it printed none. Bun
 * only warns for a file that is not an order file; a stale one (another program's indexes, a
 * different program size) it accepts without a word, which is why the build records its order from
 * the exact program it ships rather than trusting any file it is handed.
 * Example: aotOrderWarning('warn: --aot-order: /x is not an order file. Nothing is placed by it') // that line
 */
export function aotOrderWarning(compilerStderr: string): string | null {
  return /^warn: --aot-order:.*$/m.exec(compilerStderr)?.[0] ?? null;
}

/**
 * Compiles the hub with a function order recorded from that same program.
 *
 * 1. Empty `orderDir`, so no file from an earlier build can be picked up.
 * 2. Compile the hub with `--aot-record-order`, run it through the workload, take its order file.
 * 3. Compile the shipping binary with `--aot-order=<that file>` and check Bun applied it.
 * 4. Delete the recording binary and its source map (about 120 MB); the order file stays, so the
 *    build can record its hash and a release can upload it.
 *
 * If step 2 fails, or Bun reports the order unusable in step 3, a local build ships without an
 * order and says why; with `required` the build fails instead, so a release never ships without
 * the layout by accident. Skipped, with the reason logged, where recording is not wanted or not
 * possible.
 * Example: await compileWithAotOrder(plan, steps, 'dist/mangostudio')
 */
export async function compileWithAotOrder(
  plan: AotOrderPlan,
  steps: AotOrderSteps,
  outfile: string
): Promise<AotOrderCompileResult> {
  if (plan.skipReason) {
    steps.log(`   AOT function order skipped for ${plan.target}: ${plan.skipReason}`);
    return { ...(await steps.compile([], outfile)), orderSha256: null };
  }

  rmSync(plan.orderDir, { recursive: true, force: true });
  const recordingDir = join(plan.orderDir, 'record');
  const recordingBinary = join(recordingDir, plan.binaryName);
  const orderFile = join(plan.orderDir, 'hub.order');
  const startedAt = steps.now();
  steps.log(`🧭 Recording the hub's function order for ${plan.target}...`);

  try {
    let failure: string | undefined;
    const recordingBuild = await steps.compile([AOT_RECORD_ORDER_FLAG], recordingBinary);
    if (!recordingBuild.ok) {
      failure = `the recording binary did not compile (${AOT_RECORD_ORDER_FLAG})`;
    } else {
      try {
        const summary = await steps.record(recordingBinary, orderFile);
        steps.log(
          `   ${summary.functionCount} functions recorded in ${((steps.now() - startedAt) / 1000).toFixed(1)} s`
        );
      } catch (caught) {
        failure = caught instanceof Error ? caught.message : String(caught);
      }
    }

    if (failure !== undefined) {
      const message = `could not record the AOT function order for ${plan.target}: ${failure}`;
      if (plan.required)
        return { ok: false, stdout: '', stderr: '', failure: message, orderSha256: null };
      steps.warn(`⚠️  ${message}. Building without it: this hub uses about 10 MB more memory.`);
      return { ...(await steps.compile([], outfile)), orderSha256: null };
    }

    const shipped = await steps.compile([aotOrderFlag(orderFile)], outfile);
    const warning = shipped.ok ? aotOrderWarning(shipped.stderr) : null;
    if (warning === null) {
      return {
        ...shipped,
        orderSha256: shipped.ok
          ? createHash('sha256').update(readFileSync(orderFile)).digest('hex')
          : null,
      };
    }
    // The binary compiled, but Bun laid it out in source order.
    const message = `Bun did not apply the AOT function order for ${plan.target}: ${warning}`;
    if (plan.required) return { ...shipped, ok: false, failure: message, orderSha256: null };
    steps.warn(`⚠️  ${message}. This hub uses about 10 MB more memory.`);
    return { ...shipped, orderSha256: null };
  } finally {
    rmSync(recordingDir, { recursive: true, force: true });
  }
}
