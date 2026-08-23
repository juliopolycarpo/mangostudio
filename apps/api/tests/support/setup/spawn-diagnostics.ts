/**
 * Names the child processes a test run spawns, and the ones it never reaps.
 *
 * `bun test` prints `killed N dangling process` when a test times out and Bun
 * kills the children that test started. The line says nothing about *which*
 * children, and it is printed above the `(fail)` it belongs to — which is how
 * issue #922's first write-up came to blame the previous, passing test. When a
 * CI-only hang has a spawn in it, this is the instrument that says what it was.
 *
 * Off unless `MANGOSTUDIO_SPAWN_DIAGNOSTICS=1`, and free when off: the wrappers
 * are never installed, so nothing pays for a flag nobody set. The CI test lanes
 * set it (`.github/workflows/test.yml`); locally, set it for one run.
 *
 * `bun test` exposes no current-test API — neither `expect.getState()` nor a
 * hook argument carries one on 1.4.0 — so an event is stamped with elapsed time
 * instead. Interleaved with the reporter's own `(pass)`/`(fail)` lines that
 * places a spawn between two named tests, and CI's per-file `##[group]` headers
 * place it in a file.
 *
 * Wrapping by property assignment rather than `mock.module`: a module mock in
 * this repo survives `mock.restore()` and leaks into unrelated files.
 */

import { createRequire } from 'node:module';

const ENABLE_FLAG = 'MANGOSTUDIO_SPAWN_DIAGNOSTICS';

/** Enough of a command line to recognize it; some carry a whole script. */
const COMMAND_CLIP = 160;

const startedAtMs = Date.now();
let installed = false;

function clip(text: string): string {
  return text.length > COMMAND_CLIP ? `${text.slice(0, COMMAND_CLIP)}…` : text;
}

function report(event: string, detail: string): void {
  // stderr, so the ordering against the reporter's own output is the ordering
  // that happened rather than whatever two buffers agree on.
  console.error(`[spawn-diagnostics] +${Date.now() - startedAtMs}ms ${event} ${detail}`);
}

/** `Bun.spawn` takes either an argv array or an options bag carrying one. */
function bunCommandOf(args: readonly unknown[]): string {
  const [first] = args;
  if (Array.isArray(first)) return clip(first.map(String).join(' '));
  if (first !== null && typeof first === 'object' && 'cmd' in first) {
    const { cmd } = first as { cmd: unknown };
    return clip(Array.isArray(cmd) ? cmd.map(String).join(' ') : String(cmd));
  }
  return clip(String(first));
}

/** `spawn`/`exec`/`execFile`/`fork` all lead with the command, then argv. */
function nodeCommandOf(args: readonly unknown[]): string {
  const [command, maybeArgs] = args;
  return clip(
    Array.isArray(maybeArgs)
      ? `${String(command)} ${maybeArgs.map(String).join(' ')}`
      : String(command)
  );
}

/**
 * Keeps a wrapper interchangeable with what it wraps. `node:child_process`
 * hangs `util.promisify.custom` off `execFile`, and `promisify(execFile)` is a
 * real call site in this repo, so a wrapper that drops own properties changes
 * behaviour rather than only observing it.
 */
function carryOver<T extends object>(wrapper: object, original: T): T {
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original));
  return wrapper as T;
}

/** Logs a child, and its exit when it reports one, so a survivor stands out. */
function reportChild(child: unknown, command: string): void {
  if (child === null || typeof child !== 'object') return;
  const { pid } = child as { pid?: number };
  report('spawn', `pid=${pid ?? '?'} cmd="${command}"`);
  const on = (child as { on?: (event: string, listener: (...args: never[]) => void) => void }).on;
  if (typeof on !== 'function') return;
  on.call(child, 'exit', ((code: number | null, signal: string | null) => {
    report('exit', `pid=${pid ?? '?'} code=${code ?? signal ?? '?'} cmd="${command}"`);
  }) as (...args: never[]) => void);
}

/**
 * Installs the wrappers, once, if the flag is set. Safe to call from anywhere
 * that runs before the tests; the preload is where it happens.
 */
export function installSpawnDiagnostics(): void {
  if (installed || process.env[ENABLE_FLAG] !== '1') return;
  installed = true;

  const bunSpawn = Bun.spawn;
  Bun.spawn = carryOver((...args: Parameters<typeof Bun.spawn>) => {
    const child = bunSpawn(...args);
    const command = bunCommandOf(args);
    report('spawn', `pid=${child.pid} cmd="${command}"`);
    void child.exited.then(
      (code) => report('exit', `pid=${child.pid} code=${code} cmd="${command}"`),
      () => report('exit', `pid=${child.pid} code=? cmd="${command}"`)
    );
    return child;
  }, bunSpawn);

  const bunSpawnSync = Bun.spawnSync;
  Bun.spawnSync = carryOver((...args: Parameters<typeof Bun.spawnSync>) => {
    // Reported from a `finally` for the same reason the node sync wrappers are:
    // a spawn that throws — a binary that is not there — is exactly the kind of
    // event this is here to show, and it has no result to read a code off.
    const command = bunCommandOf(args);
    let outcome = 'threw';
    try {
      const result = bunSpawnSync(...args);
      outcome = `code=${result.exitCode}`;
      return result;
    } finally {
      report('spawnSync', `${outcome} cmd="${command}"`);
    }
  }, bunSpawnSync);

  // `require` rather than an import: the ESM namespace object is frozen, while
  // the CommonJS export object behind it is what every consumer — including an
  // ESM `import { spawn }` — actually reads through.
  const childProcess = createRequire(import.meta.url)('node:child_process') as Record<
    string,
    unknown
  >;
  for (const name of ['spawn', 'exec', 'execFile', 'fork'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => unknown;
    childProcess[name] = carryOver((...args: unknown[]) => {
      const child = original(...args);
      reportChild(child, nodeCommandOf(args));
      return child;
    }, original);
  }
  for (const name of ['spawnSync', 'execSync', 'execFileSync'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => unknown;
    childProcess[name] = carryOver((...args: unknown[]) => {
      const command = nodeCommandOf(args);
      try {
        return original(...args);
      } finally {
        report(name, `cmd="${command}"`);
      }
    }, original);
  }
}
