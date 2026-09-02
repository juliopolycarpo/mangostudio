/**
 * `open` command: open the running hub in the default browser.
 */

import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { isStateLive, readState, removeState } from '../../lib/server-state';
import { hubUrl } from '../../modules/machine/domain/hub-process';
import { CliError } from '../errors';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';

export interface OpenDeps {
  controller: ProcessController;
  readState: typeof readState;
  removeState: typeof removeState;
  log: (msg: string) => void;
  openUrl: (url: string) => Promise<void>;
}

/** Open the running server in a browser. // Usage: await runOpen() */
export async function runOpen(deps: Partial<OpenDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();
  if (!state || !isStateLive(state, (pid) => d.controller.isAlive(pid))) {
    if (state) await d.removeState();
    throw new CliError('MangoStudio is not running. Start it with "mangostudio serve -d".');
  }
  const url = hubUrl(state.host, state.port);
  await d.openUrl(url);
  d.log(`Opened ${url}`);
}

/** The platform's URL opener, spawned detached so the CLI returns at once. */
export function browserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

function realOpenUrl(url: string): Promise<void> {
  try {
    const child = Bun.spawn(browserCommand(process.platform, url), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      ...HIDDEN_WINDOW,
    });
    child.unref();
    return Promise.resolve();
  } catch {
    return Promise.reject(new CliError(`Could not open a browser here. Visit ${url}`));
  }
}

function resolveDeps(deps: Partial<OpenDeps>): Required<OpenDeps> {
  return {
    controller: deps.controller ?? createProcessController(),
    readState: deps.readState ?? readState,
    removeState: deps.removeState ?? removeState,
    log: deps.log ?? writeLine,
    openUrl: deps.openUrl ?? realOpenUrl,
  };
}
