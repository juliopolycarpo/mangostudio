#!/usr/bin/env bun

/**
 * `mangostudio-runtime` entry point.
 *
 * The hub spawns this binary and speaks the runtime protocol over the child's
 * pipes, so stdout carries NDJSON frames and nothing else. Every diagnostic
 * goes to stderr, which the hub forwards into its own logs.
 */

import { Console } from 'node:console';
import { createInterface } from 'node:readline/promises';
import {
  isRuntimeSlot,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeServiceMode,
  type RuntimeSlot,
  runtimeSlotAuditLogPath,
} from '@mangostudio/shared/runtime-home';
import { createRuntimeAuditSink, parseAuditSince, readRuntimeAuditLog } from './audit-log';
import { getRuntimeVersion, loadRuntimeConfig } from './config';
import { connectToHub } from './connect';
import { createSlotConsentSource } from './consent-source';
import { RuntimeServiceManagementError } from './errors';
import {
  collectRuntimeHealth,
  diagnoseRuntimeHealth,
  diagnoseRuntimeServiceHealth,
  type RuntimeDoctorFinding,
  worstSeverity,
} from './health';
import { createLocalRuntimeHost, createSlotRuntimeHost } from './runtime';
import {
  bootstrapServeToken,
  consentByInvocation,
  RUNTIME_SETUP_PENDING_MESSAGE,
  readPairingToken,
  readRuntimeSlotConfig,
  readRuntimeSlotState,
  readServeToken,
  resolveRuntimeSlot,
  resolveRuntimeSource,
  runtimeSlotDir,
  writePairingToken,
  writeRuntimeSlotConfig,
} from './runtime-home';
import { parseListenAddress, serveRuntime } from './serve';
import { createRuntimeServiceManager, resolveInstallMode } from './services/runtime-service';
import { RUNTIME_UPDATE_EXIT_CODE } from './services/runtime-update';
import {
  isRuntimeSetupProfile,
  parseAllowOverrides,
  type RuntimeSetupArgs,
  runRuntimeSetup,
} from './setup';
import { createStdioFramePort, type StdioFramePortClosure } from './transports/stdio';

/**
 * The slot `connect` and `serve` answer for.
 *
 * A runtime somebody starts by hand to pair with a hub is a `remote` one
 * whatever directory it happens to sit in: the hub did not install it there,
 * and the person running these commands is the machine's owner. That is why
 * these two name the slot instead of deriving it from the executable's path
 * the way `setup` and `health` do — and why the command they recommend has to
 * name it too, or it edits a different file than the one they just wrote.
 */
const PAIRED_SLOT = 'remote' as const;

export interface RuntimeConnectArgs {
  readonly hubUrl?: string;
  /** `stdin` reads the credential from a pipe; `env` from the environment. */
  readonly tokenSource: 'stdin' | 'env' | 'stored';
}

export interface RuntimeServeArgs {
  /** Raw `--listen` value; omitted when a previous run stored one. */
  readonly listen?: string;
  /** `stdin` / `env` override the stored serve token; otherwise stored or generated. */
  readonly tokenSource: 'stdin' | 'env' | 'stored';
}

export interface RuntimeAuditArgs {
  readonly since?: string;
  readonly denied: boolean;
  readonly json: boolean;
  readonly slot?: RuntimeSlot;
}

export type RuntimeCliInvocation =
  | { readonly command: 'stdio' }
  | { readonly command: 'connect'; readonly args: RuntimeConnectArgs }
  | { readonly command: 'serve'; readonly args: RuntimeServeArgs }
  | { readonly command: 'setup'; readonly args: RuntimeSetupArgs }
  | { readonly command: 'health'; readonly args: { readonly json: boolean } }
  | { readonly command: 'doctor'; readonly args: { readonly json: boolean } }
  | {
      readonly command: 'service';
      readonly args: {
        readonly action: 'install' | 'uninstall' | 'status';
        readonly mode?: RuntimeServiceMode;
        readonly json: boolean;
      };
    }
  | { readonly command: 'audit'; readonly args: RuntimeAuditArgs }
  | { readonly command: 'version' }
  | { readonly command: 'help' }
  | { readonly command: 'unknown'; readonly argument: string }
  /** A flag that exists, given a value it cannot take. Says which and why. */
  | { readonly command: 'invalid'; readonly reason: string };

export const RUNTIME_CLI_USAGE = `Usage: mangostudio-runtime <command>

Commands:
  --stdio      Serve the runtime protocol over stdin/stdout (NDJSON frames)
  connect      Dial a hub over WebSocket and serve it until stopped
  serve        Listen for a hub over WebSocket (Direct URL)
  setup        Say what a hub may do on this machine
  health       Print this runtime's slot, version, and permissions
  doctor       health, plus what is wrong and the command that fixes it
  service      install, uninstall, or inspect a user-level connect/serve service
  audit        Print this slot's local receipt of what a hub asked for
  --version    Print the runtime version
  --help       Show this message

connect options:
  --hub <url>  Hub endpoint, e.g. wss://hub.example.com/api/runtime
               Stored when given, so later runs need no flags. Pass it again
               to change it.
  --token -    Read the pairing token from stdin
               Or set MANGOSTUDIO_RUNTIME_TOKEN. Never pass it as an argument:
               command lines are readable by every process on the machine.

serve options:
  --listen <host:port>
               Bind address. A bare port binds 127.0.0.1. Required.
  --token -    Read the serve token from stdin
               Or set MANGOSTUDIO_RUNTIME_SERVE_TOKEN / --token env. When
               neither is given, a stored token is reused, or one is generated
               and printed once. Never pass the secret as an argument.
               MANGOSTUDIO_RUNTIME_TOKEN is for connect only.

setup options:
  --profile <full|readonly|none>
               Capability preset. Without it, setup asks. Or set
               MANGOSTUDIO_RUNTIME_SETUP, which is how images answer.
  --allow k=v[,k=v]
               Adjust single capabilities over the preset, e.g.
               --profile readonly --allow shell=true
  --audit on|off
               Record (or stop recording) what a hub asks this machine to do.
               Defaults: off for host, on for wsl and remote. Can be flipped
               alone with --yes once consent is already recorded.
  --slot <host|wsl|remote>
               Which slot to answer for. Defaults to the one this binary sits
               in; pass "remote" for a runtime you downloaded onto a PATH and
               paired with "connect" or "serve".
  --yes        Never prompt; requires --profile or the environment answer
               (or --audit alone when consent is already recorded).
  --json       Print the resulting health payload instead of prose.

health / doctor options:
  --json       Machine-readable output.

service options:
  install      Write and enable a user-level unit (systemd or launchd).
  uninstall    Disable and remove the unit.
  status       Report installed, enabled, and running.
  --mode connect|serve
               Which subcommand the unit runs (required when both are configured).
  --json       Machine-readable output (status only).

audit options:
  --since <when>
               ISO-8601 instant, or a relative duration like 24h / 30m / 7d.
  --denied     Only lines where the machine refused the call.
  --slot <host|wsl|remote>
               Which slot's log to read. Defaults to the one this binary sits in.
  --json       One JSON array on stdout.

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
  if (first === 'serve') return parseServeArgs(rest);
  if (first === 'setup') return parseSetupArgs(rest);
  if (first === 'health' || first === 'doctor') return parseReportArgs(first, rest);
  if (first === 'service') return parseServiceArgs(rest);
  if (first === 'audit') return parseAuditArgs(rest);

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

function parseSetupArgs(args: readonly string[]): RuntimeCliInvocation {
  const setup: {
    profile?: RuntimeSetupArgs['profile'];
    allow?: RuntimeSetupArgs['allow'];
    slot?: RuntimeSetupArgs['slot'];
    audit?: boolean;
    yes: boolean;
    json: boolean;
  } = { yes: false, json: false };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--profile') {
      const value = args[++index];
      if (!value || !isRuntimeSetupProfile(value)) {
        return {
          command: 'invalid',
          reason: `--profile takes full, readonly, or none${value ? `, not "${value}"` : ''}. "custom" is what any other set of permissions is called, not one you can ask for.`,
        };
      }
      setup.profile = value;
      continue;
    }
    if (flag === '--allow') {
      const value = args[++index];
      if (!value) return { command: 'invalid', reason: '--allow needs a key=value list.' };
      const parsed = parseAllowOverrides(value);
      if ('error' in parsed) return { command: 'invalid', reason: parsed.error };
      setup.allow = { ...setup.allow, ...parsed.allow };
      continue;
    }
    if (flag === '--audit') {
      const value = args[++index];
      if (!value) return { command: 'invalid', reason: '--audit takes on or off.' };
      const parsed = parseOnOff(value);
      if (parsed === null) {
        return {
          command: 'invalid',
          reason: `--audit takes on or off${value ? `, not "${value}"` : ''}.`,
        };
      }
      setup.audit = parsed;
      continue;
    }
    if (flag === '--slot') {
      const value = args[++index];
      if (!value || !isRuntimeSlot(value)) {
        return {
          command: 'invalid',
          reason: `--slot takes host, wsl, or remote${value ? `, not "${value}"` : ''}. A slot names who put a runtime on this machine, not how a hub reaches it.`,
        };
      }
      setup.slot = value;
      continue;
    }
    if (flag === '--yes' || flag === '-y') {
      setup.yes = true;
      continue;
    }
    if (flag === '--json') {
      setup.json = true;
      continue;
    }
    return { command: 'unknown', argument: flag ?? '--' };
  }

  return { command: 'setup', args: setup };
}

function parseOnOff(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === 'off' || normalized === 'false' || normalized === 'no') return false;
  return null;
}

function parseAuditArgs(args: readonly string[]): RuntimeCliInvocation {
  let since: string | undefined;
  let denied = false;
  let json = false;
  let slot: RuntimeSlot | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--since') {
      const value = args[++index];
      if (!value)
        return {
          command: 'invalid',
          reason: '--since needs an ISO-8601 instant or a relative duration like 24h.',
        };
      const parsed = parseAuditSince(value);
      if (typeof parsed === 'object') return { command: 'invalid', reason: parsed.error };
      since = parsed;
      continue;
    }
    if (flag === '--denied') {
      denied = true;
      continue;
    }
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--slot') {
      const value = args[++index];
      if (!value || !isRuntimeSlot(value)) {
        return {
          command: 'invalid',
          reason: `--slot takes host, wsl, or remote${value ? `, not "${value}"` : ''}.`,
        };
      }
      slot = value;
      continue;
    }
    return { command: 'unknown', argument: flag ?? '--' };
  }
  return {
    command: 'audit',
    args: {
      denied,
      json,
      ...(since ? { since } : {}),
      ...(slot ? { slot } : {}),
    },
  };
}

function parseReportArgs(
  command: 'health' | 'doctor',
  args: readonly string[]
): RuntimeCliInvocation {
  let json = false;
  for (const flag of args) {
    if (flag !== '--json') return { command: 'unknown', argument: flag };
    json = true;
  }
  return { command, args: { json } };
}

function parseServiceArgs(args: readonly string[]): RuntimeCliInvocation {
  const [action, ...rest] = args;
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    return { command: 'unknown', argument: action ?? 'service' };
  }
  let mode: RuntimeServiceMode | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--mode') {
      const value = rest[++index];
      if (value !== 'connect' && value !== 'serve') {
        return {
          command: 'invalid',
          reason: `--mode takes connect or serve${value ? `, not "${value}"` : ''}.`,
        };
      }
      mode = value;
      continue;
    }
    if (flag === '--json') {
      json = true;
      continue;
    }
    return { command: 'unknown', argument: flag ?? '--' };
  }
  return { command: 'service', args: { action, ...(mode ? { mode } : {}), json } };
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

function parseServeArgs(args: readonly string[]): RuntimeCliInvocation {
  let listen: string | undefined;
  let tokenSource: RuntimeServeArgs['tokenSource'] = 'stored';

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--listen') {
      const value = args[++index];
      if (!value) return { command: 'unknown', argument: '--listen' };
      listen = value;
      continue;
    }
    if (flag === '--token') {
      const value = args[++index];
      if (value === '-') tokenSource = 'stdin';
      else if (value === 'env') tokenSource = 'env';
      else return { command: 'unknown', argument: '--token' };
      continue;
    }
    return { command: 'unknown', argument: flag ?? '--' };
  }

  return { command: 'serve', args: { ...(listen ? { listen } : {}), tokenSource } };
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
    case 'serve':
      return await runServe(invocation.args, runtimeVersion);
    case 'setup':
      return await runSetup(invocation.args, runtimeVersion);
    case 'health':
      return await runHealth(invocation.args.json, runtimeVersion);
    case 'doctor':
      return await runDoctor(invocation.args.json, runtimeVersion);
    case 'service':
      return await runService(invocation.args);
    case 'audit':
      return await runAudit(invocation.args);
    case 'version':
      process.stdout.write(`${runtimeVersion}\n`);
      return 0;
    case 'help':
      process.stdout.write(`${RUNTIME_CLI_USAGE}\n`);
      return 0;
    case 'invalid':
      process.stderr.write(`${invocation.reason}\n\n${RUNTIME_CLI_USAGE}\n`);
      return 1;
    default:
      process.stderr.write(`Unknown argument: ${invocation.argument}\n\n${RUNTIME_CLI_USAGE}\n`);
      return 1;
  }
}

/**
 * Dials, and serves whatever the hub asks for.
 *
 * `connect` is the one entry point where the invocation *is* the consent, and
 * that is not a loophole. Somebody is standing at this machine holding a
 * pairing token their hub printed; asking them to run a second command before
 * the first one works would be theatre. So a slot nobody has answered for yet
 * is answered here — recorded as `full`, logged, and visible in `health`
 * afterwards, which is the part that matters. An armed gate is different: once
 * a file says `pending`, somebody deliberately staged this machine for an
 * answer, and this refuses like every other entry point until they give one.
 */
async function runConnect(args: RuntimeConnectArgs, runtimeVersion: string): Promise<number> {
  const log = (message: string): void => {
    process.stderr.write(`mangostudio-runtime: ${message}\n`);
  };

  const stored = await readRuntimeSlotConfig(PAIRED_SLOT);
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

  const consent = await consentByInvocation(PAIRED_SLOT, runtimeVersion);
  if (!consent.granted) {
    if (consent.reason) log(consent.reason);
    log(RUNTIME_SETUP_PENDING_MESSAGE);
    return 1;
  }
  if (consent.recorded) {
    log(
      `Recorded full permissions for this machine. Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" to narrow them.`
    );
  }

  await writeRuntimeSlotConfig(PAIRED_SLOT, { hubUrl });
  const { restricted } = await writePairingToken(PAIRED_SLOT, token);
  if (!restricted) {
    log(
      process.platform === 'win32'
        ? 'Warning: the pairing token file is not restricted to this account. Windows needs an ACL this runtime does not set; restrict it yourself if other accounts use this machine.'
        : 'Warning: the pairing token file could not be restricted to this user.'
    );
  }

  const audit = await slotAuditSink(PAIRED_SLOT);

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const outcome = await connectToHub({
      hubUrl,
      token,
      createHost: () =>
        createLocalRuntimeHost({
          runtimeVersion,
          consent: createSlotConsentSource({ slot: PAIRED_SLOT, initial: consent.allow }),
          audit,
          ...supervisedUpdateOptions(PAIRED_SLOT),
        }),
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
    await audit.close();
  }
}

async function runServe(args: RuntimeServeArgs, runtimeVersion: string): Promise<number> {
  const log = (message: string): void => {
    process.stderr.write(`mangostudio-runtime: ${message}\n`);
  };

  const stored = await readRuntimeSlotConfig(PAIRED_SLOT);
  const listenRaw = args.listen ?? stored.serveListen ?? undefined;
  if (!listenRaw) {
    log('No listen address. Pass --listen <host:port>, or run serve once to remember it.');
    return 1;
  }
  const listen = parseListenAddress(listenRaw);
  if (!listen) {
    log('Invalid --listen value. Pass a port, or host:port.');
    return 1;
  }

  await writeRuntimeSlotConfig(PAIRED_SLOT, { serveListen: listenRaw });

  // Same rule as `connect`: an armed gate is obeyed, an unanswered slot is
  // answered by the person who started this. What is different is the blast
  // radius — this opens a listening socket — so the recorded answer is the one
  // thing between an unattended restart and a machine nobody consented for.
  const consent = await consentByInvocation(PAIRED_SLOT, runtimeVersion);
  if (!consent.granted) {
    if (consent.reason) log(consent.reason);
    log(RUNTIME_SETUP_PENDING_MESSAGE);
    return 1;
  }
  if (consent.recorded) {
    log(
      `Recorded full permissions for this machine. Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" to narrow them.`
    );
  }

  const resolved = await resolveServeToken(args.tokenSource);
  if (!resolved) {
    log(
      'No serve token. Pipe one in with --token -, set MANGOSTUDIO_RUNTIME_SERVE_TOKEN, or omit --token to generate one.'
    );
    return 1;
  }

  if (resolved.generated) {
    if (!resolved.restricted) {
      log(
        process.platform === 'win32'
          ? 'Warning: the serve token file is not restricted to this account. Windows needs an ACL this runtime does not set; restrict it yourself if other accounts use this machine.'
          : 'Warning: the serve token file could not be restricted to this user.'
      );
    }
    log(`Serve token (shown once): ${resolved.token}`);
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const audit = await slotAuditSink(PAIRED_SLOT);

  try {
    const handle = serveRuntime({
      listen,
      token: resolved.token,
      createHost: () =>
        createLocalRuntimeHost({
          runtimeVersion,
          consent: createSlotConsentSource({ slot: PAIRED_SLOT, initial: consent.allow }),
          audit,
          ...supervisedUpdateOptions(PAIRED_SLOT),
        }),
      log,
      signal: controller.signal,
    });
    await handle.stopped;
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await audit.close();
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
  return source === 'env' ? null : await readPairingToken(PAIRED_SLOT);
}

async function resolveServeToken(source: RuntimeServeArgs['tokenSource']): Promise<{
  readonly token: string;
  readonly generated: boolean;
  readonly restricted?: boolean;
} | null> {
  if (source === 'stdin') {
    const piped = (await Bun.stdin.text()).trim();
    // Operator-supplied secrets stay out of credentials.json on purpose.
    return piped.length > 0 ? { token: piped, generated: false } : null;
  }
  const fromEnv = loadRuntimeConfig().serveToken;
  if (source === 'env') {
    return fromEnv ? { token: fromEnv, generated: false } : null;
  }
  if (fromEnv) return { token: fromEnv, generated: false };
  const stored = await readServeToken(PAIRED_SLOT);
  if (stored) return { token: stored, generated: false };
  const bootstrapped = await bootstrapServeToken(PAIRED_SLOT);
  return {
    token: bootstrapped.token,
    generated: true,
    restricted: bootstrapped.restricted,
  };
}

async function serveStdio(runtimeVersion: string): Promise<number> {
  redirectConsoleToStderr();

  // SSH (and any other hub launch) speaks stdio, not serve. The consent gate has
  // to live here too or a pending slot still starts a fully functional host and
  // the hub's setup-pending classifier never sees its signature.
  const consent = await stdioConsent();
  if (consent.refusal) {
    process.stderr.write(`mangostudio-runtime: ${consent.refusal}\n`);
    return 1;
  }

  let stop: (closure: StdioFramePortClosure) => void = () => undefined;
  const finished = new Promise<StdioFramePortClosure>((resolve) => {
    stop = resolve;
  });
  let updateCommitted = false;
  const { host, audit } = await createSlotRuntimeHost({
    runtimeVersion,
    consent: createSlotConsentSource({ slot: consent.slot, initial: consent.allow }),
    update: {
      // A hub-spawned slot binary is relaunched through `current`; a custom
      // stdio path would restart the same old path, so publish there but leave
      // the restart to its owner.
      supervised: resolveRuntimeSource() === 'provisioned',
      requestRestart: () => {
        updateCommitted = true;
        stop({ kind: 'eof' });
      },
    },
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

  const closure = await finished.finally(async () => {
    process.off('SIGINT', stopOnSignal);
    process.off('SIGTERM', stopOnSignal);
    host.close();
    // `close` drains what `host.close()` only scheduled, so the last records
    // of a session reach disk before the process leaves — the same guarantee
    // `connect` and `serve` already give.
    await audit.close();
  });

  if (closure.kind === 'protocol-error') {
    process.stderr.write(`mangostudio-runtime: ${closure.error.message}\n`);
    return 1;
  }
  if (updateCommitted) return RUNTIME_UPDATE_EXIT_CODE;
  return 0;
}

/** What a launched runtime may do here, and why it may not when it may not. */
export interface StdioConsent {
  readonly slot: RuntimeSlot;
  /** The sentence to print and exit on, or null when the launch may serve. */
  readonly refusal: string | null;
  readonly allow: RuntimeCapabilityAllow;
}

const DENY_EVERYTHING = RUNTIME_CONSENT_PRESETS.none;

/**
 * Why a hub-launched runtime must not serve, or null when it may.
 *
 * Unlike `connect` and `serve`, there is nobody here to take the invocation as
 * consent: a hub started this over ssh, and the account that owns the machine
 * may be asleep. So a `remote` slot with no answer refuses, while `host` and
 * `wsl` proceed — those were placed by an install somebody on this machine ran.
 * A config that cannot be read refuses in every slot: an unknown answer must
 * not resolve to the slot default, because the file it replaced may have said
 * something narrower.
 *
 * Every refusal carries the setup-pending signature, because every one of them
 * is fixed by the same command and the hub tells them apart from a missing
 * binary by that phrase.
 *
 * A custom `remoteRuntimePath` outside the slot tree reads as `host` and is not
 * gated; giving a launch its slot is what closes that, and it is a follow-up.
 */
export async function stdioConsent(
  env: NodeJS.ProcessEnv = process.env,
  executablePaths: readonly string[] = [process.execPath, process.argv[1] ?? '']
): Promise<StdioConsent> {
  const slot = resolveRuntimeSlot(env, executablePaths);
  const { config, error } = await readRuntimeSlotState(slot, env);
  if (error) {
    return { slot, refusal: `${error} ${RUNTIME_SETUP_PENDING_MESSAGE}`, allow: DENY_EVERYTHING };
  }
  if (config.setup.state === 'pending') {
    return { slot, refusal: RUNTIME_SETUP_PENDING_MESSAGE, allow: DENY_EVERYTHING };
  }
  return { slot, refusal: null, allow: config.allow };
}

async function runSetup(args: RuntimeSetupArgs, runtimeVersion: string): Promise<number> {
  // `setup` is a conversation, not a protocol stream, so it owns stdout here.
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  // Nothing can prompt down a pipe, and a prompt nobody answers is a hang. An
  // ssh channel and a container build both land here.
  if (!process.stdin.isTTY) {
    return await runRuntimeSetup(args, { runtimeVersion, write });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runRuntimeSetup(args, {
      runtimeVersion,
      write,
      ask: (question) => rl.question(question),
    });
  } finally {
    rl.close();
  }
}

async function runHealth(json: boolean, runtimeVersion: string): Promise<number> {
  const report = await collectRuntimeHealth({ runtimeVersion });
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `slot        ${report.slot} (${report.source})`,
      `directory   ${runtimeSlotDir(report.slot)}`,
      `version     ${report.runtimeVersion}`,
      `binary      ${report.binaryPath ?? 'workspace entry (source checkout)'}`,
      `digest      ${report.digest ?? '-'}`,
      `profile     ${report.profile} (${report.setup.state})`,
      // `none` grants nothing, and a bare `allow` with trailing space reads as
      // a line that failed to render rather than one that says so.
      `allow       ${
        Object.entries(report.allow)
          .filter(([, granted]) => granted)
          .map(([key]) => key)
          .join(', ') || 'none'
      }`,
      `shells      ${report.shells.join(', ') || 'none'}`,
      `git         ${report.git.available ? (report.git.version ?? 'available') : 'not found'}`,
      `audit       ${report.audit === undefined ? '-' : report.audit.enabled ? 'on' : 'off'}`,
      ...(report.auditError ? [`audit error ${report.auditError}`] : []),
      ...(report.lastError ? [`error       ${report.lastError}`] : []),
      '',
    ].join('\n')
  );
  return 0;
}

async function runAudit(args: RuntimeAuditArgs): Promise<number> {
  const slot = args.slot ?? resolveRuntimeSlot();
  const path = runtimeSlotAuditLogPath(slot, {
    mangoHome: loadRuntimeConfig().mangoHome,
    platform: process.platform,
  });
  const records = await readRuntimeAuditLog({
    path,
    ...(args.since ? { since: args.since } : {}),
    deniedOnly: args.denied,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(records)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write(
      `No audit lines for the ${slot} runtime${args.denied ? ' (denied only)' : ''}.\n`
    );
    return 0;
  }
  for (const record of records) {
    const bits = [record.ts, record.outcome, record.method, record.hub, `${record.durationMs}ms`];
    if (record.capability) bits.push(`capability=${record.capability}`);
    if (record.code) bits.push(`code=${record.code}`);
    if (record.args) bits.push(JSON.stringify(record.args));
    process.stdout.write(`${bits.join(' ')}\n`);
  }
  return 0;
}

async function slotAuditSink(slot: RuntimeSlot) {
  const { config } = await readRuntimeSlotState(slot);
  return createRuntimeAuditSink({ slot, enabled: config.audit.enabled });
}

/** Exits non-zero on a failure so a provisioner can gate on it. */
async function runDoctor(json: boolean, runtimeVersion: string): Promise<number> {
  const report = await collectRuntimeHealth({ runtimeVersion });
  const findings = [
    ...diagnoseRuntimeHealth(report),
    ...(await diagnoseRuntimeServiceHealth(report)),
  ];

  if (json) {
    process.stdout.write(`${JSON.stringify({ health: report, findings })}\n`);
  } else {
    for (const finding of findings) process.stdout.write(`${renderFinding(finding)}\n`);
  }
  return worstSeverity(findings) === 'fail' ? 1 : 0;
}

async function runService(args: {
  readonly action: 'install' | 'uninstall' | 'status';
  readonly mode?: RuntimeServiceMode;
  readonly json: boolean;
}): Promise<number> {
  const manager = createRuntimeServiceManager();
  try {
    if (args.action === 'install') {
      const slotState = await readRuntimeSlotState(PAIRED_SLOT);
      const mode = resolveInstallMode(args.mode, slotState.config);
      await manager.install(mode);
      if (!args.json) {
        process.stdout.write(`Installed and started mangostudio-runtime ${mode} service.\n`);
      }
      return 0;
    }
    if (args.action === 'uninstall') {
      await manager.uninstall();
      if (!args.json) process.stdout.write('Removed mangostudio-runtime service.\n');
      return 0;
    }
    const status = await manager.status();
    if (args.json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      process.stdout.write(
        [
          `installed  ${status.installed}`,
          `enabled    ${status.enabled}`,
          `running    ${status.running}`,
          ...(status.linger === undefined ? [] : [`linger     ${status.linger}`]),
          ...(status.execUsesCurrent === undefined ? [] : [`current    ${status.execUsesCurrent}`]),
          ...(status.manager?.unitPath ? [`unit       ${status.manager.unitPath}`] : []),
          '',
        ].join('\n')
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RuntimeServiceManagementError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      process.stderr.write(`mangostudio-runtime: ${message}\n`);
    }
    return 1;
  }
}

function supervisedUpdateOptions(_slot: RuntimeSlot): {
  readonly update?: {
    readonly supervised: boolean;
    readonly requestRestart: () => void;
  };
} {
  if (resolveRuntimeSource() !== 'provisioned') return {};
  return {
    update: {
      supervised: true,
      requestRestart: () => {
        process.exit(RUNTIME_UPDATE_EXIT_CODE);
      },
    },
  };
}

function renderFinding(finding: RuntimeDoctorFinding): string {
  const mark = finding.severity === 'ok' ? 'ok  ' : finding.severity === 'warn' ? 'warn' : 'fail';
  const line = `${mark}  ${finding.title.padEnd(8)} ${finding.detail}`;
  return finding.fix ? `${line}\n            fix: ${finding.fix}` : line;
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
