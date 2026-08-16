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
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

const regex = new RegExp(workerData.source, workerData.flags);

parentPort.on('message', (request) => {
  let content;
  try {
    content = readFileSync(request.path, 'utf8');
  } catch {
    // Vanished or unreadable between the caller's probe and this read.
    parentPort.postMessage({ matches: [], moreMatches: false });
    return;
  }

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

/**
 * Creates a scanner for one compiled pattern. The worker starts on the first
 * file and is replaced whenever a budget expires, so the cost is paid once per
 * grep call rather than once per file.
 *
 * // Usage: const scanner = createGrepScanner(regex); try { … } finally { await scanner.close(); }
 */
export function createGrepScanner(regex: RegExp): GrepScanner {
  let worker: Worker | undefined;
  let closed = false;

  const start = (): Worker => {
    const started = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: regex.source, flags: regex.flags },
    });
    // A worker can die with no scan waiting on it, and then nothing else would
    // notice: an unhandled 'error' on a Worker is fatal to the whole process,
    // and a dead one left in `worker` would take the next file's whole budget
    // to be found out. Both events retire it so the next scan starts a new one.
    started.on('error', () => retire(started));
    started.on('exit', () => retire(started));
    return started;
  };

  const retire = (target: Worker): void => {
    if (worker === target) worker = undefined;
  };

  const discard = (target: Worker): void => {
    retire(target);
    void target.terminate().catch(() => undefined);
  };

  return {
    async scan(path, maxMatches, budgetMs) {
      if (closed) return UNFINISHED;
      worker ??= start();
      const active = worker;

      return await new Promise<GrepScanOutcome>((resolve) => {
        const settle = (outcome: GrepScanOutcome) => {
          clearTimeout(timer);
          active.off('message', onMessage);
          active.off('error', onError);
          active.off('exit', onExit);
          resolve(outcome);
        };
        const onMessage = (message: {
          matches: GrepScanOutcome['matches'];
          moreMatches: boolean;
        }) => settle({ ...message, incomplete: false });
        const onError = () => {
          // A worker that threw cannot be reused, and one file failing to scan
          // is not a reason to fail the whole search — but it is also not proof
          // that the file holds nothing, so the caller is told the scan is short.
          settle(UNFINISHED);
          discard(active);
        };
        // A worker that exits with a scan outstanding answers nothing at all.
        // Without this the file would sit out its whole budget and then be
        // reported as a timeout it never reached.
        const onExit = () => {
          settle(UNFINISHED);
          retire(active);
        };
        const timer = setTimeout(() => {
          // Terminating is the only way to stop a synchronous match; the worker
          // is past the point where it could answer a message.
          settle(UNFINISHED);
          discard(active);
        }, budgetMs);

        active.once('message', onMessage);
        active.once('error', onError);
        active.once('exit', onExit);
        active.postMessage({ path, maxMatches });
      });
    },
    async close() {
      closed = true;
      const active = worker;
      worker = undefined;
      if (active) await active.terminate().catch(() => undefined);
    },
  };
}
