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

/** How long to wait for a hub this command started to answer its own health check. */
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

/** Take a fresh install to an open browser. // Usage: await runSetup({ open: true }) */
export async function runSetup(args: SetupArgs, deps: Partial<SetupDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);

  const existing = await liveHub(d);
  const state = existing ?? (await startHub(args, d));
  if (existing) d.log(`MangoStudio is already running (PID ${existing.pid}).`);

  const url = hubUrl(state.host, state.port);
  await offerBrowser(url, args, d);
}

/**
 * The hub already serving, or `null`.
 *
 * A stale state file from a crashed process is cleared here rather than being
 * reported as a running instance, so `setup` on a machine that lost power is
 * the same one command as `setup` on a fresh one.
 */
async function liveHub(d: Required<SetupDeps>): Promise<ServerState | null> {
  const state = await d.readState();
  if (!state) return null;
  if (!isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    await d.removeState();
    return null;
  }
  return (await d.confirmsHealthy(state.host, state.port)) ? state : null;
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

  const state = await waitForHub(d);
  if (!state) {
    throw new CliError(
      'MangoStudio was started but never answered its health check. Run "mangostudio logs" to see why.'
    );
  }
  return state;
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

/** Poll until the hub this command started writes its state file and answers. */
async function waitForHub(d: Required<SetupDeps>): Promise<ServerState | null> {
  const deadline = d.now() + READY_TIMEOUT_MS;
  while (d.now() < deadline) {
    const state = await liveHub(d);
    if (state) return state;
    await d.sleep(READY_POLL_MS);
  }
  return null;
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
