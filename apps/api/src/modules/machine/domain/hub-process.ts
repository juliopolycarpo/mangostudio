/**
 * The serving hub process as a status document, derived from the single-
 * instance state file. Shared by `mangostudio status --json` and the machine
 * API so both describe the same process with the same fields.
 */

import type { HubHealth, HubLaunchMode, HubProcessStatus } from '@mangostudio/shared/machine';
import { formatHostForUrl } from '../../../lib/ip-address';
import type { ServerState } from '../../../lib/server-state';

const BIND_ALL_HOSTS = new Set(['0.0.0.0', '::']);

/** How the process was started, which decides how it can be restarted. */
export function hubLaunchMode(state: Pick<ServerState, 'logFile' | 'service'>): HubLaunchMode {
  if (state.service) return 'service';
  return state.logFile ? 'detached' : 'foreground';
}

/** The address a browser on this machine opens. // Usage: hubUrl('0.0.0.0', 3001) */
export function hubUrl(host: string, port: number): string {
  const shown = BIND_ALL_HOSTS.has(host) ? 'localhost' : formatHostForUrl(host);
  return `http://${shown}:${port}`;
}

export interface DescribeHubProcessInput {
  readonly state: ServerState | null;
  readonly alive: boolean;
  readonly now: number;
  readonly health?: HubHealth;
}

/** Turn the state file into the shared status shape. // Usage: describeHubProcess({ state, alive, now }) */
export function describeHubProcess(input: DescribeHubProcessInput): HubProcessStatus {
  const { state } = input;
  if (!state || !input.alive) return { running: false };
  return {
    running: true,
    pid: state.pid,
    port: state.port,
    host: state.host,
    url: hubUrl(state.host, state.port),
    startedAt: state.startedAt,
    uptimeMs: Math.max(0, input.now - state.startedAt),
    logFile: state.logFile,
    version: state.version,
    ...(state.buildInfo
      ? {
          buildSha: state.buildInfo.gitSha,
          buildType: state.buildInfo.buildType,
          builtAt: state.buildInfo.builtAt,
        }
      : {}),
    ...(input.health ? { health: input.health } : {}),
    launch: hubLaunchMode(state),
    ...(state.service ? { serviceUnit: state.service } : {}),
  };
}
