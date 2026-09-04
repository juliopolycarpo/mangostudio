/**
 * The exec seam `upgrade-service.ts` runs the embedded install script (and a
 * POSIX package-manager delegation) through, so the engine never calls
 * `Bun.spawn` directly and a test never has to spawn a real process to cover
 * it.
 *
 * Lines from stdout and stderr are relayed as they arrive, interleaved in
 * the order the process actually produced them — the engine turns each one
 * into an `output` stream event verbatim, so a caller watching the upgrade
 * sees the install script's own progress rather than a buffered dump at the
 * end.
 */

import { HIDDEN_WINDOW } from '@mangostudio/runtime';

export interface ScriptOutputLine {
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
}

export interface ScriptRun {
  readonly lines: AsyncIterable<ScriptOutputLine>;
  readonly exitCode: Promise<number>;
}

export interface RunScriptOptions {
  readonly env: Record<string, string>;
  readonly cwd?: string;
}

export type RunScript = (argv: readonly string[], options: RunScriptOptions) => ScriptRun;

/** A `ScriptRun` that never spawned anything — one synthetic stderr line and a fixed exit code. */
/** An `AsyncIterable` yielding exactly one item, with no `async function*` (and so no idle await). */
function oneLine(item: ScriptOutputLine): AsyncIterable<ScriptOutputLine> {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next: (): Promise<IteratorResult<ScriptOutputLine>> => {
          if (done) return Promise.resolve({ done: true, value: undefined });
          done = true;
          return Promise.resolve({ done: false, value: item });
        },
      };
    },
  };
}

function immediateRun(message: string, exitCode: number): ScriptRun {
  return {
    lines: oneLine({ stream: 'stderr', line: message }),
    exitCode: Promise.resolve(exitCode),
  };
}

/**
 * Default exec seam, backed by `Bun.spawn`. `Bun.spawn` throws synchronously
 * when the program is not on PATH; that becomes a one-line stderr report and
 * exit 127, the same convention a shell uses for "command not found", rather
 * than a rejected promise the caller would have to special-case.
 * // Usage: runScript(['bash', scriptPath, '--local', archivePath], { env })
 */
export const runScript: RunScript = (argv, options) => {
  const [program, ...args] = argv;
  if (!program) return immediateRun('Refusing to run an empty command.', 127);

  try {
    const proc = spawnPiped(program, args, options);
    return { lines: mergeOutputLines(proc), exitCode: proc.exited };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return immediateRun(`${program}: ${reason}`, 127);
  }
};

/** `Bun.spawn` with an explicit return type, so it stays a piped subprocess rather than the generic default union. */
function spawnPiped(
  program: string,
  args: readonly string[],
  options: RunScriptOptions
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn({
    cmd: [program, ...args],
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...HIDDEN_WINDOW,
  });
}

/** Splits a byte stream into UTF-8 lines, tagging each with `stream`, and pushes them through `push`. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  streamName: ScriptOutputLine['stream'],
  push: (line: ScriptOutputLine) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      push({ stream: streamName, line: buffer.slice(0, newline).replace(/\r$/, '') });
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) push({ stream: streamName, line: buffer.replace(/\r$/, '') });
}

/**
 * Interleaves stdout and stderr lines in the order they actually arrive, via
 * a small push queue: each reader pushes a line and wakes the consumer,
 * rather than the consumer polling either stream in a fixed order (which
 * would starve whichever stream it did not ask first).
 */
async function* mergeOutputLines(proc: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}): AsyncGenerator<ScriptOutputLine> {
  const queue: ScriptOutputLine[] = [];
  let wake: (() => void) | null = null;
  const push = (line: ScriptOutputLine): void => {
    queue.push(line);
    wake?.();
    wake = null;
  };

  let readersDone = false;
  const readers = Promise.all([
    pumpLines(proc.stdout, 'stdout', push),
    pumpLines(proc.stderr, 'stderr', push),
  ]).then(() => {
    readersDone = true;
    wake?.();
    wake = null;
  });

  for (;;) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    if (readersDone) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await readers;
}
