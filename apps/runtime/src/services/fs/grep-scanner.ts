/**
 * Off-thread evaluation of a grep pattern, under a wall-clock budget.
 *
 * The pattern comes from the model, and a JavaScript regular expression has no
 * step limit: `^(a+)+$` against one long non-matching line can hold the engine
 * for seconds, and the runtime shares its event loop with the whole hub. The
 * per-file and per-match caps do not help, because they are checked between
 * lines and a single `test` cannot be interrupted.
 *
 * So the scan runs in a worker thread and the main thread holds a timer. If the
 * budget expires the worker is terminated and the file is reported as scanned
 * only in part. The budget is what makes this sound; nothing here tries to
 * decide whether a pattern is "safe" by looking at it.
 *
 * A worker keeps the full JavaScript regular-expression dialect the grep tool
 * already promises, which swapping in a non-backtracking engine would not.
 *
 * The pool of workers is module-scoped and shared across every `fs.grep` call
 * in the process, rather than one worker per call: starting a thread costs far
 * more than most greps do, and narrow — the shape most calls have — is exactly
 * where that startup cost dominates instead of amortising. A bounded pool with
 * a request queue in front, rather than one shared worker, is the deliberate
 * choice here: a worker terminated for an expired budget still takes down only
 * the one request it was running, the same isolation a fresh worker per call
 * gave for free. What it trades for is the pool's own lifecycle, handled at the
 * `ref`/`unref` and teardown calls below.
 */

import { Worker } from 'node:worker_threads';

interface GrepScanOutcome {
  readonly matches: ReadonlyArray<{ readonly line: number; readonly text: string }>;
  /** A further line matched after the allowance ran out. */
  readonly moreMatches: boolean;
  /**
   * The file was not read to the end: the budget expired, or the worker holding
   * the scan died. Both have to be distinguishable from "no matches here",
   * because reporting a search that never ran as empty is a wrong answer rather
   * than a slow one.
   */
  readonly incomplete: boolean;
}

export interface GrepScanner {
  /**
   * Scans one file for the compiled pattern, collecting at most `maxMatches`.
   * Never rejects on a file it cannot read: an unreadable file has no matches,
   * which is what the caller does with it either way. A scan that could not run
   * is reported as `incomplete` instead, so the caller can flag the search.
   */
  scan(path: string, maxMatches: number, budgetMs: number): Promise<GrepScanOutcome>;
  close(): Promise<void>;
}

/**
 * Nothing matched because the scan never finished — a dead worker or an expired
 * budget. Distinct from the worker's own empty answer, which did read the file.
 */
const UNFINISHED: GrepScanOutcome = { matches: [], moreMatches: false, incomplete: true };

/**
 * The worker body, as source rather than a module of its own.
 *
 * Inline because the runtime ships as a compiled single-file binary: a separate
 * worker entrypoint is a file path that has to survive bundling, and a path that
 * silently fails to resolve there would take grep down in the binary while every
 * check, test and build stayed green. A string in the bundle cannot go missing.
 *
 * The pattern travels in each request message rather than `workerData`, since
 * one worker now serves every pattern the pool sends it, not just the one it
 * was started for.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

parentPort.on('message', (request) => {
  let content;
  try {
    content = readFileSync(request.path, 'utf8');
  } catch {
    // Vanished or unreadable between the caller's probe and this read.
    parentPort.postMessage({ matches: [], moreMatches: false });
    return;
  }

  const regex = new RegExp(request.source, request.flags);
  const lines = content.split('\\n');
  const matches = [];
  let moreMatches = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!regex.test(line)) continue;
    if (matches.length >= request.maxMatches) {
      moreMatches = true;
      break;
    }
    matches.push({ line: index + 1, text: line });
  }
  parentPort.postMessage({ matches, moreMatches });
});
`;

/** Bounds how many grep scans can run off-thread at once. */
const GREP_POOL_SIZE = 4;

interface PoolWorker {
  readonly worker: Worker;
  busy: boolean;
}

let pool: PoolWorker[] = [];
/** FIFO of scans waiting for a worker, once the pool is full and all busy. */
const waiters: Array<(entry: PoolWorker) => void> = [];

function spawnPoolWorker(): PoolWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  const entry: PoolWorker = { worker, busy: false };
  // Idle until handed to a scan, so it must not keep the process alive by
  // itself; `acquire` refs it back for as long as a request is outstanding.
  worker.unref();
  // A worker can die with no scan waiting on it, and then nothing else would
  // notice: an unhandled 'error' on a Worker is fatal to the whole process,
  // and a dead one left in the pool would take the next scan's whole budget
  // to be found out. Only handled here when idle — a worker that dies with a
  // scan in flight is already settled and discarded by that scan's own
  // listeners in `runOnWorker`, and handling it twice would double-discard.
  worker.on('error', () => {
    if (!entry.busy) discard(entry);
  });
  worker.on('exit', () => {
    if (!entry.busy) discard(entry);
  });
  return entry;
}

/**
 * Checks a worker out to a caller. Busy and ref'd travel together: a worker
 * running a request must not be the reason the process can exit, and must not
 * be handed to a second request.
 */
function checkOut(entry: PoolWorker): PoolWorker {
  entry.busy = true;
  entry.worker.ref();
  return entry;
}

/** Spawns a worker already checked out to its caller and adds it to the pool. */
function spawnCheckedOutWorker(): PoolWorker {
  const entry = checkOut(spawnPoolWorker());
  pool.push(entry);
  return entry;
}

/** Removes a worker from the pool and hands a fresh one to whoever is waiting next. */
function discard(entry: PoolWorker): void {
  pool = pool.filter((item) => item !== entry);
  void entry.worker.terminate().catch(() => undefined);
  // Optional call short-circuits, so no replacement is spawned with nobody waiting.
  waiters.shift()?.(spawnCheckedOutWorker());
}

/** Hands back an idle worker, spawning one if the pool has room, or queues the request. */
function acquire(): Promise<PoolWorker> {
  const idle = pool.find((entry) => !entry.busy);
  if (idle) return Promise.resolve(checkOut(idle));
  if (pool.length < GREP_POOL_SIZE) return Promise.resolve(spawnCheckedOutWorker());
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** Returns a worker to the pool: straight to the next waiter, or idle and unref'd. */
function release(entry: PoolWorker): void {
  const waiter = waiters.shift();
  if (waiter) {
    // Stays busy and ref'd — handed directly to the next queued scan rather
    // than going idle in between.
    waiter(entry);
    return;
  }
  entry.busy = false;
  entry.worker.unref();
}

/**
 * Terminates every pooled worker and clears the queue.
 *
 * The pool holds OS threads for the life of the process once a burst has grown
 * it, and `unref` only stops them blocking exit — it does not release them. A
 * runtime whose services have been closed should not still be holding four
 * worker threads, so the registry's teardown calls this alongside the other
 * service closers. A grep issued afterwards simply grows the pool again.
 */
export async function closeGrepPool(): Promise<void> {
  const entries = pool;
  pool = [];
  waiters.length = 0;
  await Promise.all(entries.map((entry) => entry.worker.terminate().catch(() => undefined)));
}

interface ScanMessage {
  readonly path: string;
  readonly maxMatches: number;
  readonly source: string;
  readonly flags: string;
}

/**
 * Runs one scan on an already-acquired worker. Each pool worker serves at most
 * one request at a time — `acquire` guarantees that — so the `once` listeners
 * here cannot cross-talk with another scan's reply.
 */
function runOnWorker(
  entry: PoolWorker,
  message: ScanMessage,
  budgetMs: number
): Promise<GrepScanOutcome> {
  const { worker } = entry;
  return new Promise<GrepScanOutcome>((resolve) => {
    const settle = (outcome: GrepScanOutcome) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', abandon);
      worker.off('exit', abandon);
      resolve(outcome);
    };
    const onMessage = (reply: { matches: GrepScanOutcome['matches']; moreMatches: boolean }) => {
      settle({ ...reply, incomplete: false });
      release(entry);
    };
    // The three ways a scan ends without an answer, all handled alike. A worker
    // that threw cannot be reused; one that exited answers nothing at all, and
    // without this the file would sit out its whole budget and be reported as a
    // timeout it never reached; and terminating is the only way to stop a
    // synchronous match once the budget is gone. One file failing to scan is not
    // a reason to fail the whole search — but it is also not proof that the file
    // holds nothing, so the caller is told the scan is short either way.
    const abandon = () => {
      settle(UNFINISHED);
      discard(entry);
    };
    const timer = setTimeout(abandon, budgetMs);

    worker.once('message', onMessage);
    worker.once('error', abandon);
    worker.once('exit', abandon);
    worker.postMessage(message);
  });
}

/**
 * Creates a scanner for one compiled pattern, drawing from the shared pool for
 * every file it scans. Closing this scanner only stops it from starting new
 * scans of its own — the pool it drew from keeps serving every other grep call
 * already in flight.
 *
 * // Usage: const scanner = createGrepScanner(regex); try { … } finally { await scanner.close(); }
 */
export function createGrepScanner(regex: RegExp): GrepScanner {
  let closed = false;

  return {
    async scan(path, maxMatches, budgetMs) {
      if (closed) return UNFINISHED;
      const entry = await acquire();
      if (closed) {
        // Closed while queued for a worker: the caller has abandoned this
        // scan, but the worker itself is fine and belongs back in the shared
        // pool for the next one.
        release(entry);
        return UNFINISHED;
      }
      return runOnWorker(
        entry,
        { path, maxMatches, source: regex.source, flags: regex.flags },
        budgetMs
      );
    },
    // Not `async`: with the workers owned by the pool there is nothing left to
    // await here, and biome's `useAwait` rejects an async function without one.
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}
