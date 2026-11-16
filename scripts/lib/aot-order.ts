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

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  createIsolatedHubHome,
  isolatedHubEnv,
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
 * Why a build cannot use a recorded order, or `null` when it can. A native build runs on its own
 * target, so it can run the binary it records; Bun can only record on Linux, and the bytecode
 * fallback is not an AOT build at all.
 * Example: aotOrderSkipReason('native', 'darwin') // 'Bun records AOT function order on Linux only (host: darwin)'
 */
export function aotOrderSkipReason(compiler: string, hostPlatform: string): string | null {
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
    // `P <program size>` and `M <index> <module>` describe the program; `F ...` is one function.
    if (/^(?:P \d+|M \d+ \S+)$/.test(line)) continue;
    if (/^F (?:=|\d+) \d+ \S+ \S+ \S+ ?$/.test(line)) {
      functionCount += 1;
      continue;
    }
    throw new Error(
      `aot order: expected a "P <n>", "M <n> <module>" or "F <...>" line | received: ${JSON.stringify(line)}`
    );
  }
  if (functionCount === 0) {
    throw new Error(
      'aot order: expected at least one "F ..." line | received: none, so the run recorded no function'
    );
  }
  return { functionCount };
}

/** Options of `recordAotOrder`; both are replaceable so a test can use a fake hub. */
export interface RecordAotOrderOptions {
  /** Requests sent to the recording hub once it is healthy. Defaults to the shared hub workload. */
  readonly workload?: (baseUrl: string) => Promise<unknown>;
  /** Ceiling for the whole run. Defaults to `RECORDING_DEADLINE_MS`. */
  readonly deadlineMs?: number;
}

/**
 * Runs a `--aot-record-order` hub through the workload, stops it with SIGTERM so it writes its
 * order file, and returns the file's summary. The hub gets a throwaway home inside the OS temp
 * directory, a loopback port the OS chose, and sees only loopback requests; the one file it is
 * pointed at outside that home is the order file. Whatever happens, the hub's process group is
 * killed and reaped and the home deleted before this returns.
 * Example: await recordAotOrder('.mango/aot-order/linux-x64/record/mangostudio', '.mango/aot-order/linux-x64/hub.order')
 */
export async function recordAotOrder(
  recordingBinary: string,
  orderFile: string,
  options: RecordAotOrderOptions = {}
): Promise<AotOrderSummary> {
  const workload = options.workload ?? runHubWorkload;
  const deadlineMs = options.deadlineMs ?? RECORDING_DEADLINE_MS;
  mkdirSync(dirname(orderFile), { recursive: true });
  rmSync(orderFile, { force: true });
  const home = createIsolatedHubHome();
  let hub: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await reserveEphemeralPort();
    hub = Bun.spawn([recordingBinary, 'serve', String(port)], {
      env: { ...isolatedHubEnv(home, port), BUN_AOT_ORDER_OUT: orderFile },
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const running = hub;
    const stderr = new Response(running.stderr).text();
    const run = (async (): Promise<AotOrderSummary> => {
      await waitForHealth(`http://127.0.0.1:${port}/api/health`, running);
      await workload(`http://127.0.0.1:${port}`);
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
      deadline = setTimeout(() => {
        reject(
          new Error(
            `aot order: expected the recording run to finish within ${deadlineMs} ms | received: still running`
          )
        );
      }, deadlineMs);
    });
    return await Promise.race([run, expired]);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (hub) {
      try {
        process.kill(-hub.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
      await hub.exited;
    }
    removeIsolatedHubHome(home);
  }
}

async function waitForHealth(url: string, hub: Bun.Subprocess): Promise<void> {
  while (hub.exitCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) return;
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

/** Final result: the shipping compile's outcome plus the reason it was not produced, when it was not. */
export interface AotOrderCompileResult extends CompileOutcome {
  readonly failure?: string;
}

/**
 * Compiles the hub with a function order recorded from that same program.
 *
 * 1. Empty `orderDir`, so no file from an earlier build can be picked up.
 * 2. Compile the hub with `--aot-record-order`, run it through the workload, take its order file.
 * 3. Compile the shipping binary with `--aot-order=<that file>`.
 *
 * If step 2 fails the shipping binary is still built, without an order, and the warning names the
 * reason; with `required` the build fails instead, so a release never ships without the layout by
 * accident. Skipped, with the reason logged, where recording is not possible.
 * Example: await compileWithAotOrder(plan, steps, 'dist/mangostudio')
 */
export async function compileWithAotOrder(
  plan: AotOrderPlan,
  steps: AotOrderSteps,
  outfile: string
): Promise<AotOrderCompileResult> {
  if (plan.skipReason) {
    steps.log(`   AOT function order skipped for ${plan.target}: ${plan.skipReason}`);
    return steps.compile([], outfile);
  }

  rmSync(plan.orderDir, { recursive: true, force: true });
  const recordingBinary = join(plan.orderDir, 'record', plan.binaryName);
  const orderFile = join(plan.orderDir, 'hub.order');
  const startedAt = steps.now();
  steps.log(`🧭 Recording the hub's function order for ${plan.target}...`);

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
    if (plan.required) return { ok: false, stdout: '', failure: message };
    steps.warn(`⚠️  ${message}. Building without it: this hub uses about 10 MB more memory.`);
    return steps.compile([], outfile);
  }
  return steps.compile([aotOrderFlag(orderFile)], outfile);
}
