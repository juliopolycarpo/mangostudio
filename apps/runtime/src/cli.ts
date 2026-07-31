#!/usr/bin/env bun

/**
 * `mangostudio-runtime` entry point.
 *
 * The hub spawns this binary and speaks the runtime protocol over the child's
 * pipes, so stdout carries NDJSON frames and nothing else. Every diagnostic
 * goes to stderr, which the hub forwards into its own logs.
 */

import { Console } from 'node:console';
import { getRuntimeVersion } from './config';
import { createLocalRuntimeHost } from './runtime';
import { createStdioFramePort, type StdioFramePortClosure } from './transports/stdio';

export type RuntimeCliInvocation =
  | { readonly command: 'stdio' }
  | { readonly command: 'version' }
  | { readonly command: 'help' }
  | { readonly command: 'unknown'; readonly argument: string };

export const RUNTIME_CLI_USAGE = `Usage: mangostudio-runtime <command>

Commands:
  --stdio      Serve the runtime protocol over stdin/stdout (NDJSON frames)
  --version    Print the runtime version
  --help       Show this message

MangoStudio spawns this binary for stdio environments; it is not meant to be
run interactively. stdout carries protocol frames only — diagnostics go to
stderr.`;

/**
 * Both spellings are accepted for every mode: the hub passes the documented
 * `--stdio` flag, while the bare word leaves room for the dial-out and listen
 * subcommands the remote transports add.
 */
export function parseRuntimeCliArgs(args: readonly string[]): RuntimeCliInvocation {
  const [first, ...rest] = args;
  const extra = rest[0];
  if (extra !== undefined) return { command: 'unknown', argument: extra };

  switch (first) {
    case '--stdio':
    case 'stdio':
      return { command: 'stdio' };
    case '-v':
    case '--version':
    case 'version':
      return { command: 'version' };
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      return { command: 'help' };
    default:
      return { command: 'unknown', argument: first };
  }
}

/** Runs one CLI invocation and resolves with its process exit code. */
export async function runRuntimeCli(args: readonly string[]): Promise<number> {
  const invocation = parseRuntimeCliArgs(args);
  const runtimeVersion = getRuntimeVersion();

  switch (invocation.command) {
    case 'stdio':
      return await serveStdio(runtimeVersion);
    case 'version':
      process.stdout.write(`${runtimeVersion}\n`);
      return 0;
    case 'help':
      process.stdout.write(`${RUNTIME_CLI_USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown argument: ${invocation.argument}\n\n${RUNTIME_CLI_USAGE}\n`);
      return 1;
  }
}

async function serveStdio(runtimeVersion: string): Promise<number> {
  redirectConsoleToStderr();

  const host = createLocalRuntimeHost({ runtimeVersion });
  let stop: (closure: StdioFramePortClosure) => void = () => undefined;
  const finished = new Promise<StdioFramePortClosure>((resolve) => {
    stop = resolve;
  });
  // A hub shutdown signals the child before closing the pipe; unwind the same
  // way an EOF would so in-flight handlers see their abort.
  const stopOnSignal = () => stop({ kind: 'eof' });

  host.attach(
    createStdioFramePort({ input: process.stdin, output: process.stdout, onClosed: stop })
  );
  host.start();
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);

  const closure = await finished.finally(() => {
    process.off('SIGINT', stopOnSignal);
    process.off('SIGTERM', stopOnSignal);
    host.close();
  });

  if (closure.kind === 'protocol-error') {
    process.stderr.write(`mangostudio-runtime: ${closure.error.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * stdout is the protocol stream, so one stray `console.log` anywhere in the
 * runtime would inject a record the hub's decoder has to reject — taking the
 * whole connection down. `log` is only the obvious emitter: `dir`, `table`,
 * `group`, `count`, `timeEnd` and friends write to stdout too. Rather than
 * enumerate them — and flatten the stateful ones onto `error` in the process —
 * give the console a stream pair that points at stderr, which the hub already
 * collects, and let every method keep its own behaviour.
 */
function redirectConsoleToStderr(): void {
  // A console whose stream pair points at stderr on both sides. Copying its
  // methods over the global keeps each one's own behaviour — group indentation,
  // table rendering, the `count` and `time` tallies — while the writes land on
  // the stream the hub reads as diagnostics.
  const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  Object.assign(globalThis.console, stderrConsole);
  // `write` is Bun's own raw emitter, not part of the node Console surface, so
  // the copy above leaves it aimed at the protocol stream.
  globalThis.console.write = (data: string): number => {
    process.stderr.write(data);
    return data.length;
  };
}

if (import.meta.main) {
  process.exitCode = await runRuntimeCli(process.argv.slice(2));
}
