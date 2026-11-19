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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  createIsolatedHubHome,
  guardIsolatedHub,
  isolatedHubEnv,
  ownsServerState,
  removeIsolatedHubHome,
  reserveEphemeralPort,
} from './hub-process';
import { runHubWorkload } from './hub-workload';
import { type ReleaseBinaryName, runtimeBinaryName } from './release-targets';

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
  /** Lines of a kind this parser does not know (a newer Bun may add some); passed through. */
  readonly unknownLineCount: number;
  /** The distinct first tokens of those lines, sorted. */
  readonly unknownLineKinds: readonly string[];
}

/** Line kinds Bun writes that the build has no use for: program size, entry and module names. */
const DESCRIPTIVE_LINE_KINDS: ReadonlySet<string> = new Set(['P', 'E', 'M']);

/**
 * Checks only what the build relies on and returns the file's summary: the header, and at least one
 * function line (an empty recording means the workload ran nothing). Every other line is Bun's to
 * judge; a kind this parser does not know is counted and reported, not an error, because the order
 * file comes from a floating Bun canary that may add lines, and Bun's own warning about a file it
 * cannot use already fails a required build. Throws where Bun would only warn and carry on.
 * Example: parseAotOrder('aot-order v1\nP 39150\nF = 7066 b0 - 0:0 \n') // { functionCount: 1, unknownLineCount: 0, unknownLineKinds: [] }
 */
export function parseAotOrder(text: string): AotOrderSummary {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines[0] !== ORDER_FILE_HEADER) {
    throw new Error(
      `aot order: expected first line "${ORDER_FILE_HEADER}" | received: ${JSON.stringify(lines[0] ?? '')}`
    );
  }
  let functionCount = 0;
  let unknownLineCount = 0;
  const unknownKinds = new Set<string>();
  for (const line of lines.slice(1)) {
    const kind = line.split(' ', 1)[0] as string;
    if (kind === 'F') functionCount += 1;
    else if (!DESCRIPTIVE_LINE_KINDS.has(kind)) {
      unknownLineCount += 1;
      unknownKinds.add(kind);
    }
  }
  if (functionCount === 0) {
    throw new Error(
      'aot order: expected at least one "F ..." line | received: none, so the run recorded no function'
    );
  }
  return { functionCount, unknownLineCount, unknownLineKinds: [...unknownKinds].sort() };
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
  /**
   * A `mangostudio-runtime` for this platform. It is copied beside the recording hub, where an
   * installed hub finds its runtime, so the order covers the code a hub runs with Local attached.
   * Without it the hub starts alone and a Local launch finds no binary.
   */
  readonly runtimeBinary?: string;
  /** How long after the workload the hub gets to have launched that runtime. Defaults to 15 s. */
  readonly runtimeAttachDeadlineMs?: number;
}

/**
 * Puts `runtimeBinary` next to the recording hub under the name the hub looks for, and returns that
 * path. A missing file throws here, with its path, instead of as a Local launch failure the
 * recording would carry on past.
 * Example: placeRuntimeBeside('.mango/aot-order/linux-x64/record/mangostudio', '/in/mangostudio-runtime')
 */
export function placeRuntimeBeside(recordingBinary: string, runtimeBinary: string): string {
  if (!existsSync(runtimeBinary)) {
    throw new Error(
      `aot order: expected the recording runtime at ${runtimeBinary} | received: no such file`
    );
  }
  const sibling = join(
    dirname(recordingBinary),
    runtimeBinaryName(basename(recordingBinary) as ReleaseBinaryName)
  );
  copyFileSync(runtimeBinary, sibling);
  chmodSync(sibling, 0o755);
  return sibling;
}

/**
 * Pids of the direct children of `parentPid` whose command line names `runtimeName`, read from
 * procfs (Linux, which is the only place an order is recorded). The hub launches Local as a
 * `<runtime> --stdio` child, so this is how a recording proves the runtime was attached and not
 * refused or never started, which the hub survives without a word. `procRoot` is replaceable so a
 * test can use a fake procfs.
 * Example: runtimeChildPids(4242, 'mangostudio-runtime') // [4243]
 */
export function runtimeChildPids(
  parentPid: number,
  runtimeName: string,
  procRoot = '/proc'
): number[] {
  const found: number[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join(procRoot, entry, 'stat'), 'utf8');
      // The command name is parenthesised and may hold spaces: count fields from the last `)`.
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (parent !== parentPid) continue;
      // A script runs as `<interpreter> <script>`, a binary as itself: accept the name anywhere.
      const argv = readFileSync(join(procRoot, entry, 'cmdline'), 'utf8').split('\0');
      if (argv.some((argument) => basename(argument) === runtimeName)) found.push(Number(entry));
    } catch {
      // The process ended while it was being read.
    }
  }
  return found;
}

/** How long a hub that has finished the workload gets to have launched its runtime. */
const RUNTIME_ATTACH_DEADLINE_MS = 15_000;

/**
 * Waits until `hubPid` has the runtime as a child, or throws naming what it waited for.
 * Example: await waitForRuntimeChild(hub.pid, 'mangostudio-runtime')
 */
async function waitForRuntimeChild(
  hubPid: number,
  runtimeName: string,
  deadlineMs: number
): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (runtimeChildPids(hubPid, runtimeName).length === 0) {
    if (Date.now() > until) {
      throw new Error(
        `aot order: expected the recording hub to launch ${runtimeName} within ${deadlineMs} ms of the workload | received: no child process of pid ${hubPid} with that name, so the order would not cover a hub with Local attached`
      );
    }
    await Bun.sleep(100);
  }
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
 * With `options.runtimeBinary` the hub runs with that runtime beside it, so the order also covers
 * the code a hub runs once Local is attached. Without it the order covers the hub's start-up and
 * request paths and a Local launch that finds no binary (see the AOT section of
 * `docs/reference/runtime-metrics.md`).
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
    const runtimeSibling =
      options.runtimeBinary === undefined
        ? undefined
        : placeRuntimeBeside(recordingBinary, options.runtimeBinary);
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
      if (runtimeSibling !== undefined) {
        progress = 'waiting for the hub to launch its runtime';
        await waitForRuntimeChild(
          running.pid,
          basename(runtimeSibling),
          options.runtimeAttachDeadlineMs ?? RUNTIME_ATTACH_DEADLINE_MS
        );
      }
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
      // The musl legs build in a container as root, and the file the hub writes is not readable
      // by the runner user that uploads it afterwards. A function order holds no secret.
      chmodSync(orderFile, 0o644);
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
  // A hub killed by a signal has `exitCode === null` and a `signalCode`, so the exit code alone
  // never ends this loop after `recordAotOrder` SIGKILLs the group: it would keep requesting
  // `/api/health` for as long as the process lives, into whatever test spies on `fetch` next.
  while (hub.exitCode === null && hub.signalCode === null) {
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
    `aot order: expected ${url} to answer 200 before the hub exited | received: hub exit ${hub.exitCode ?? `signal ${hub.signalCode}`}`
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
  /** Runs the recording hub; `runtimeBinary` is the runtime to place beside it, when there is one. */
  record(
    recordingBinary: string,
    orderFile: string,
    runtimeBinary?: string
  ): Promise<AotOrderSummary>;
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
  /** A runtime to run beside the recording hub, so the order covers a hub with Local attached. */
  readonly runtimeBinary?: string;
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
        const summary = await steps.record(recordingBinary, orderFile, plan.runtimeBinary);
        steps.log(
          `   ${summary.functionCount} functions recorded in ${((steps.now() - startedAt) / 1000).toFixed(1)} s`
        );
        if (summary.unknownLineCount > 0) {
          steps.log(
            `   ${summary.unknownLineCount} order-file lines of kind ${summary.unknownLineKinds.join(', ')} are unknown to this build and passed through to Bun`
          );
        }
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
