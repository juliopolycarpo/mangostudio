#!/usr/bin/env bun

/**
 * `mangostudio-runtime` entry point.
 *
 * The hub spawns this binary and speaks the runtime protocol over the child's
 * pipes, so stdout carries NDJSON frames and nothing else. Every diagnostic
 * goes to stderr, which the hub forwards into its own logs.
 */

import { Console } from 'node:console';
import { getRuntimeVersion, loadRuntimeConfig } from './config';
import { connectToHub } from './connect';
import { createLocalRuntimeHost } from './runtime';
import {
  readPairingToken,
  readRuntimeSlotConfig,
  writePairingToken,
  writeRuntimeSlotConfig,
} from './runtime-home';
import { createStdioFramePort, type StdioFramePortClosure } from './transports/stdio';

export interface RuntimeConnectArgs {
  readonly hubUrl?: string;
  /** `stdin` reads the credential from a pipe; `env` from the environment. */
  readonly tokenSource: 'stdin' | 'env' | 'stored';
}

export type RuntimeCliInvocation =
  | { readonly command: 'stdio' }
  | { readonly command: 'connect'; readonly args: RuntimeConnectArgs }
  | { readonly command: 'version' }
  | { readonly command: 'help' }
  | { readonly command: 'unknown'; readonly argument: string };

export const RUNTIME_CLI_USAGE = `Usage: mangostudio-runtime <command>

Commands:
  --stdio      Serve the runtime protocol over stdin/stdout (NDJSON frames)
  connect      Dial a hub over WebSocket and serve it until stopped
  --version    Print the runtime version
  --help       Show this message

connect options:
  --hub <url>  Hub endpoint, e.g. wss://hub.example.com/api/runtime
               Stored when given, so later runs need no flags. Pass it again
               to change it.
  --token -    Read the pairing token from stdin
               Or set MANGOSTUDIO_RUNTIME_TOKEN. Never pass it as an argument:
               command lines are readable by every process on the machine.

MangoStudio spawns this binary for stdio environments; it is not meant to be
run interactively there. stdout carries protocol frames only — diagnostics go
to stderr.`;

/**
 * Both spellings are accepted for every mode: the hub passes the documented
 * `--stdio` flag, while the bare word is what a subcommand looks like.
 */
export function parseRuntimeCliArgs(args: readonly string[]): RuntimeCliInvocation {
  const [first, ...rest] = args;

  if (first === 'connect') return parseConnectArgs(rest);

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

function parseConnectArgs(args: readonly string[]): RuntimeCliInvocation {
  let hubUrl: string | undefined;
  let tokenSource: RuntimeConnectArgs['tokenSource'] = 'stored';

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--hub') {
      const value = args[++index];
      if (!value) return { command: 'unknown', argument: '--hub' };
      hubUrl = value;
      continue;
    }
    if (flag === '--token') {
      const value = args[++index];
      // The only accepted values are the two that keep the secret out of argv.
      if (value === '-') tokenSource = 'stdin';
      else if (value === 'env') tokenSource = 'env';
      else return { command: 'unknown', argument: '--token' };
      continue;
    }
    return { command: 'unknown', argument: flag ?? '--' };
  }

  return { command: 'connect', args: { ...(hubUrl ? { hubUrl } : {}), tokenSource } };
}

/** Runs one CLI invocation and resolves with its process exit code. */
export async function runRuntimeCli(args: readonly string[]): Promise<number> {
  const invocation = parseRuntimeCliArgs(args);
  const runtimeVersion = getRuntimeVersion();

  switch (invocation.command) {
    case 'stdio':
      return await serveStdio(runtimeVersion);
    case 'connect':
      return await runConnect(invocation.args, runtimeVersion);
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

/**
 * Dials, and serves whatever the hub asks for.
 *
 * Note what is *not* checked here yet: whether the machine's owner has agreed
 * to any of it. The consent gate belongs before the dial — a runtime whose slot
 * is still `pending` should refuse and name `setup` rather than connect and
 * then decide per call — but the setup CLI that writes that state does not
 * exist, and a gate reading a field nothing writes is a gate that is always
 * open while looking closed. Until it lands, connecting is the consent: the
 * operator ran this command on this machine with a token they were handed.
 */
async function runConnect(args: RuntimeConnectArgs, runtimeVersion: string): Promise<number> {
  const log = (message: string): void => {
    process.stderr.write(`mangostudio-runtime: ${message}\n`);
  };

  const stored = await readRuntimeSlotConfig('remote');
  const hubUrl = args.hubUrl ?? stored.hubUrl;
  if (!hubUrl) {
    log('No hub URL. Pass --hub <url>; the pairing card in MangoStudio prints it.');
    return 1;
  }

  const token = await resolveToken(args.tokenSource);
  if (!token) {
    log(
      'No pairing token. Pipe one in with --token -, or set MANGOSTUDIO_RUNTIME_TOKEN. It is never accepted as a command-line argument.'
    );
    return 1;
  }

  await writeRuntimeSlotConfig('remote', { hubUrl });
  const { restricted } = await writePairingToken('remote', token);
  if (!restricted) {
    log(
      process.platform === 'win32'
        ? 'Warning: the pairing token file is not restricted to this account. Windows needs an ACL this runtime does not set; restrict it yourself if other accounts use this machine.'
        : 'Warning: the pairing token file could not be restricted to this user.'
    );
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const outcome = await connectToHub({
      hubUrl,
      token,
      createHost: () => createLocalRuntimeHost({ runtimeVersion }),
      log,
      signal: controller.signal,
    });
    if (outcome.reason === 'refused') {
      log(outcome.message ?? 'The hub refused this runtime.');
      return 1;
    }
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function resolveToken(source: RuntimeConnectArgs['tokenSource']): Promise<string | null> {
  if (source === 'stdin') {
    const piped = (await Bun.stdin.text()).trim();
    return piped.length > 0 ? piped : null;
  }
  const fromEnv = loadRuntimeConfig().pairingToken;
  if (fromEnv) return fromEnv;
  // `--token` was not given and the environment is empty: fall back to whatever
  // a previous run stored, which is what makes an unattended restart work.
  return source === 'env' ? null : await readPairingToken('remote');
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
