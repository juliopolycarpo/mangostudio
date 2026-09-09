/**
 * `setup` command: the terminal twin of the browser's first-run flow.
 *
 * It answers the one question the web wizard cannot, because it needs a running
 * hub to be asked at all: how to get from an installed binary to a page in a
 * browser. Everything it does is an existing command — the auth-secret setup
 * `serve` performs, the service install, the detached start, the browser open —
 * sequenced so that a person who has just installed MangoStudio has one thing
 * to type.
 *
 * It never claims to have done what it has not: an already-running hub is
 * reused rather than restarted, a browser that cannot be opened here is
 * replaced by the URL and how to reach it, and a choice that would normally be
 * a prompt is refused rather than assumed when there is nobody to ask.
 */

import { isStateLive, readState, removeState, type ServerState } from '../../lib/server-state';
import { hubUrl } from '../../modules/machine/domain/hub-process';
import type { SetupArgs } from '../args';
import { ensureServeAuthSecret } from '../auth-secret-setup';
import { CliError } from '../errors';
import { confirmsHealthy } from '../health';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';
import { isInteractiveTerminal, promptYesNo } from '../prompt';
import { sleep } from '../sleep';
import { openUrl } from './open';
import { runServe } from './serve';
import { runService } from './service';

/** How long to wait for a hub — one this command started, or one already up — to answer. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

export interface SetupDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  ensureAuthSecret: typeof ensureServeAuthSecret;
  runService: typeof runService;
  runServe: typeof runServe;
  confirmsHealthy: typeof confirmsHealthy;
  isInteractive: () => boolean;
  promptYesNo: (question: string) => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * What this machine's state file and a health check together say about a hub.
 *
 * `starting` is the member worth naming: a process that is alive but not yet
 * answering is the hub this command wants, not a reason to launch a second one.
 */
type HubProbe =
  | { readonly kind: 'healthy'; readonly state: ServerState }
  | { readonly kind: 'starting'; readonly state: ServerState }
  | { readonly kind: 'absent' };

/** Take a fresh install to an open browser. // Usage: await runSetup({ open: true }) */
export async function runSetup(args: SetupArgs, deps: Partial<SetupDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);

  const reused = await existingHub(d);
  if (reused) reportIgnoredTarget(args, reused, d);
  const state = reused ?? (await startHub(args, d));
  const url = hubUrl(state.host, state.port);
  await offerBrowser(url, args, d);
}

/**
 * Say when the hub being *reused* is not listening where the command was told
 * to listen.
 *
 * `setup` never restarts what is already serving, so an explicit target can go
 * unhonoured — and silently opening a different address is how someone ends up
 * certain the flag did nothing. Only the reuse path can reach this: a hub this
 * command started was started with the target, so there is nothing to warn
 * about and "stop it first" would be advice about a process it just launched.
 *
 * The two addresses are compared as URLs so the bind-all aliases collapse
 * together and `setup lan` on a hub already bound to `0.0.0.0` stays quiet.
 */
function reportIgnoredTarget(args: SetupArgs, state: ServerState, d: Required<SetupDeps>): void {
  const requested = hubUrl(args.host ?? state.host, args.port ?? state.port);
  const running = hubUrl(state.host, state.port);
  if (requested === running) return;
  d.log(
    `Kept the hub already running at ${running}; the requested ${requested} was not applied. ` +
      'Run "mangostudio stop" first to move it.'
  );
}

/**
 * Read what is on this machine.
 *
 * A stale state file from a crashed process is cleared here rather than being
 * reported as a running instance, so `setup` on a machine that lost power is
 * the same one command as `setup` on a fresh one.
 */
async function probeHub(d: Required<SetupDeps>): Promise<HubProbe> {
  const state = await d.readState();
  if (!state) return { kind: 'absent' };
  if (!isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    await d.removeState();
    return { kind: 'absent' };
  }
  return (await d.confirmsHealthy(state.host, state.port))
    ? { kind: 'healthy', state }
    : { kind: 'starting', state };
}

/**
 * The hub already on this machine, or `null` when there is none to reuse.
 *
 * A live process that has not answered yet is waited for rather than replaced.
 * `serve` refuses to start beside a live pid, so treating "not healthy" as
 * "nothing there" fails the command with an error about an instance the person
 * never started — and a hub still booting, or one briefly failing `/health`, is
 * exactly what `setup` runs into on a machine somebody just installed.
 */
async function existingHub(d: Required<SetupDeps>): Promise<ServerState | null> {
  const probe = await probeHub(d);
  if (probe.kind === 'absent') return null;
  if (probe.kind === 'healthy') {
    d.log(`MangoStudio is already running (PID ${probe.state.pid}).`);
    return probe.state;
  }

  d.log(`MangoStudio is running (PID ${probe.state.pid}) but has not answered yet. Waiting.`);
  const settled = await pollHub(d, (candidate) => candidate.kind === 'starting');
  if (settled.kind === 'healthy') return settled.state;
  // The process went away while we waited: nothing to reuse, and starting one is
  // now the right answer rather than an error about a hub that is no longer there.
  if (settled.kind === 'absent') return null;
  throw new CliError(
    `MangoStudio is running (PID ${settled.state.pid}) but is not answering its health check. ` +
      'Run "mangostudio logs" to see why, or "mangostudio stop" to replace it.'
  );
}

async function startHub(args: SetupArgs, d: Required<SetupDeps>): Promise<ServerState> {
  // Before anything is started, and while a terminal is still attached: a unit
  // has no stdin, and a hub that starts without a usable secret refuses every
  // request it then accepts a connection for.
  await d.ensureAuthSecret({ log: d.log });

  const target = {
    ...(args.host === undefined ? {} : { host: args.host }),
    ...(args.port === undefined ? {} : { port: args.port }),
  };

  if (await wantsService(args, d)) {
    await d.runService({ action: 'install', json: false, ...target });
  } else {
    d.log('Starting MangoStudio in the background.');
    await d.runServe({ detached: true, ...target });
  }

  const ready = await pollHub(d, (candidate) => candidate.kind !== 'healthy');
  if (ready.kind !== 'healthy') {
    throw new CliError(
      'MangoStudio was started but never answered its health check. Run "mangostudio logs" to see why.'
    );
  }
  return ready.state;
}

/**
 * Whether to install the service unit.
 *
 * With nobody at the keyboard this is refused rather than guessed in either
 * direction: installing one is a change to the machine that outlives the
 * command, and skipping one silently would leave a scripted install with a hub
 * that dies at logout while reporting success.
 */
function wantsService(args: SetupArgs, d: Required<SetupDeps>): Promise<boolean> {
  if (args.service !== undefined) return Promise.resolve(args.service);
  if (!d.isInteractive()) {
    throw new CliError(
      'Nothing is attached to answer whether to install the background service. Pass --service or --no-service.'
    );
  }
  return d.promptYesNo(
    'Install MangoStudio as a background service, so it comes back after logout and reboot?'
  );
}

/**
 * Poll the hub until `keepWaiting` says to stop, or the deadline passes.
 *
 * The two callers are waiting for different things and say so: a hub this
 * command just started has not written its state file yet, so `absent` is a
 * normal early answer; a hub that was already up going `absent` means the
 * process has gone, and there is nothing left to wait for.
 */
async function pollHub(
  d: Required<SetupDeps>,
  keepWaiting: (probe: HubProbe) => boolean
): Promise<HubProbe> {
  const deadline = d.now() + READY_TIMEOUT_MS;
  let probe = await probeHub(d);
  while (keepWaiting(probe) && d.now() < deadline) {
    await d.sleep(READY_POLL_MS);
    probe = await probeHub(d);
  }
  return probe;
}

/**
 * Open the browser when one can be opened here, and always print the URL.
 *
 * The distinction matters over SSH: claiming "opened in your browser" when the
 * command ran on a machine with no display sends the user looking for a window
 * that was never going to appear.
 */
async function offerBrowser(url: string, args: SetupArgs, d: Required<SetupDeps>): Promise<void> {
  if (!args.open) {
    d.log(`MangoStudio is running at ${url}`);
    return;
  }
  if (!canOpenBrowser(d.platform, d.env)) {
    d.log(`MangoStudio is running at ${url}`);
    d.log(
      'No browser can be opened from here. Open that address on this machine, or forward the port: ' +
        `ssh -L ${portOf(url)}:localhost:${portOf(url)} <this-host>`
    );
    return;
  }
  try {
    await d.openUrl(url);
    d.log(`Opened ${url}`);
  } catch {
    d.log(`MangoStudio is running at ${url}. Open it in a browser to finish setting up.`);
  }
}

function portOf(url: string): string {
  return new URL(url).port;
}

/**
 * Whether a browser could plausibly be opened by this process.
 *
 * macOS and Windows always have a way to ask the desktop. On Linux there has to
 * be a display to ask: a session over SSH with none is the case this exists
 * for, and it is common enough that guessing wrong is the normal outcome rather
 * than the rare one.
 *
 * @example
 * canOpenBrowser('linux', { SSH_CONNECTION: '...' }); // => false
 */
export function canOpenBrowser(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function resolveDeps(deps: Partial<SetupDeps>): Required<SetupDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    ensureAuthSecret: deps.ensureAuthSecret ?? ensureServeAuthSecret,
    runService: deps.runService ?? runService,
    runServe: deps.runServe ?? runServe,
    confirmsHealthy: deps.confirmsHealthy ?? confirmsHealthy,
    isInteractive: deps.isInteractive ?? isInteractiveTerminal,
    promptYesNo: deps.promptYesNo ?? promptYesNo,
    openUrl: deps.openUrl ?? openUrl,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
  };
}
