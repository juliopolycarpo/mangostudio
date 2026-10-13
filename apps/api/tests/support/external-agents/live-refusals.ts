/**
 * Pieces of the opt-in live refusal smoke: which cases were requested, the
 * environment that puts a real vendor CLI into a refused state without touching
 * its sign-in, and the small named fakes that keep the rest of the hub real.
 *
 * Nothing here logs in, logs out, or reads a credential. A signed-out state is a
 * vendor's own config-home variable pointed at an empty scratch directory the
 * test created; an outdated state is an older official binary placed first on
 * `PATH`.
 */

import { delimiter, dirname, join } from 'node:path';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import {
  type ExternalAgentDescriptor,
  type ExternalAgentTargetId,
  type ExternalAgentUnavailableReason,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { EnvironmentProbingService } from '../../../src/modules/environments/application/probing-service';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';

const LIVE_REFUSAL_CASE_IDS = [
  'codex-signed-out',
  'claude-signed-out',
  'cursor-signed-out',
  'codex-outdated',
  'codex-outdated-reopen',
  'codex-child-killed-between-turns',
  'claude-reopen-after-connection-drop',
  'claude-reopen-after-killed-turn',
] as const;

type LiveRefusalCaseId = (typeof LIVE_REFUSAL_CASE_IDS)[number];

export interface LiveRefusalCase {
  readonly id: LiveRefusalCaseId;
  readonly targetId: ExternalAgentTargetId;
  /**
   * The unavailable reason the selector and the refused send are expected to carry. Absent for a
   * case that refuses nothing.
   */
  readonly reason?: Extract<ExternalAgentUnavailableReason, 'signed-out' | 'version-unsupported'>;
  /**
   * Whether discovery already reports the reason. Cursor's status surface says nothing usable
   * when signed out (`authState: unknown`), so only its open refuses.
   */
  readonly selectorRefuses: boolean;
  /**
   * `open` refuses the first open of a session. `reopen` completes a turn, makes the agent
   * outdated, ends its process so the session drops, and sends again: the reopen is refused.
   * `child-killed` completes a turn, ends the vendor's own process under the live session, and
   * sends again on the signed-in account: the hub reopens once and the turn completes.
   * `connection-dropped` restarts the runtime between two sends on the signed-in account: the
   * hub reopens on the new runtime and the second send must recall the first.
   * `killed-turn` ends the runtime in the middle of a turn (a kill the vendor does not get to
   * finish), restarts it, and sends again: the stored conversation holds a turn the vendor left
   * unfinished, so the hub must open a new conversation and say so.
   */
  readonly flow: 'open' | 'reopen' | 'child-killed' | 'connection-dropped' | 'killed-turn';
}

export const LIVE_REFUSAL_CASES: readonly LiveRefusalCase[] = [
  {
    id: 'codex-signed-out',
    targetId: 'codex',
    reason: 'signed-out',
    selectorRefuses: true,
    flow: 'open',
  },
  {
    id: 'claude-signed-out',
    targetId: 'claude',
    reason: 'signed-out',
    selectorRefuses: true,
    flow: 'open',
  },
  {
    id: 'cursor-signed-out',
    targetId: 'cursor',
    reason: 'signed-out',
    selectorRefuses: false,
    flow: 'open',
  },
  {
    id: 'codex-outdated',
    targetId: 'codex',
    reason: 'version-unsupported',
    selectorRefuses: true,
    flow: 'open',
  },
  {
    id: 'codex-outdated-reopen',
    targetId: 'codex',
    reason: 'version-unsupported',
    selectorRefuses: false,
    flow: 'reopen',
  },
  {
    id: 'codex-child-killed-between-turns',
    targetId: 'codex',
    selectorRefuses: false,
    flow: 'child-killed',
  },
  {
    id: 'claude-reopen-after-connection-drop',
    targetId: 'claude',
    selectorRefuses: false,
    flow: 'connection-dropped',
  },
  {
    id: 'claude-reopen-after-killed-turn',
    targetId: 'claude',
    selectorRefuses: false,
    flow: 'killed-turn',
  },
];

/**
 * The unavailable reason a refusing case expects.
 *
 * @example
 * refusedReason(codexSignedOut); // 'signed-out'
 */
export function refusedReason(
  refusal: LiveRefusalCase
): Extract<ExternalAgentUnavailableReason, 'signed-out' | 'version-unsupported'> {
  if (!refusal.reason) {
    throw new Error(`expected case ${refusal.id} to name a refusal reason | received: none`);
  }
  return refusal.reason;
}

/**
 * The cases `MANGOSTUDIO_LIVE_AGENT_REFUSALS` names, in the order they are defined.
 *
 * An unknown name throws instead of being skipped: a typo would otherwise read as
 * a green run that observed nothing.
 *
 * @example
 * requestedRefusalCases('codex-signed-out,codex-outdated').map((entry) => entry.id);
 * // ['codex-signed-out', 'codex-outdated']
 */
export function requestedRefusalCases(raw: string | undefined): readonly LiveRefusalCase[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const known = new Set<string>(LIVE_REFUSAL_CASE_IDS);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `expected MANGOSTUDIO_LIVE_AGENT_REFUSALS to name only ${LIVE_REFUSAL_CASE_IDS.join(' | ')} | received: ${unknown.join(', ')}`
    );
  }
  return LIVE_REFUSAL_CASES.filter((entry) => names.includes(entry.id));
}

export interface RefusalEnvironmentInput {
  /** An empty directory the test created and owns. */
  readonly emptyDirectory: string;
  /** The directory holding the older `codex`; required for `codex-outdated` and `codex-outdated-reopen`. */
  readonly outdatedCodexDirectory?: string;
  /** The directory holding the real `cursor-agent`; required for `cursor-signed-out`. */
  readonly cursorDirectory?: string;
  /** The `PATH` the runtime would otherwise inherit. */
  readonly inheritedPath: string | undefined;
}

/**
 * The variables layered over the runtime child's environment for one case.
 *
 * @example
 * refusalEnvironment(codexSignedOut, { emptyDirectory: '/tmp/empty', inheritedPath: '/usr/bin' });
 * // { CODEX_HOME: '/tmp/empty' }
 */
export function refusalEnvironment(
  refusal: LiveRefusalCase,
  input: RefusalEnvironmentInput
): Record<string, string> {
  const { emptyDirectory, inheritedPath } = input;
  switch (refusal.id) {
    case 'codex-signed-out':
      return { CODEX_HOME: emptyDirectory };
    case 'claude-signed-out':
      return { CLAUDE_CONFIG_DIR: emptyDirectory };
    case 'cursor-signed-out': {
      if (!input.cursorDirectory) {
        throw new Error(
          'expected the directory of the real cursor-agent for cursor-signed-out | received: none'
        );
      }
      // HOME moves with the config home; the real binary stays reachable by absolute path.
      return {
        HOME: emptyDirectory,
        USERPROFILE: emptyDirectory,
        XDG_CONFIG_HOME: join(emptyDirectory, '.config'),
        PATH: pathWith(input.cursorDirectory, inheritedPath),
      };
    }
    case 'codex-child-killed-between-turns':
    case 'claude-reopen-after-connection-drop':
    case 'claude-reopen-after-killed-turn':
      // The signed-in account and the current codex, untouched: only the process is ended.
      return {};
    case 'codex-outdated-reopen':
    case 'codex-outdated': {
      if (!input.outdatedCodexDirectory) {
        throw new Error(
          'expected MANGOSTUDIO_LIVE_OUTDATED_CODEX_DIR to name the directory of an older codex | received: none'
        );
      }
      return {
        CODEX_HOME: emptyDirectory,
        PATH: pathWith(input.outdatedCodexDirectory, inheritedPath),
      };
    }
  }
}

function pathWith(first: string, inherited: string | undefined): string {
  return inherited ? `${first}${delimiter}${inherited}` : first;
}

/**
 * The path a lookup found, or throws naming the program.
 *
 * @example
 * requiredExecutable('codex', Bun.which('codex')); // '/home/ada/.local/bin/codex'
 */
export function requiredExecutable(program: string, located: string | null | undefined): string {
  if (!located) throw new Error(`expected ${program} to be on PATH | received: not found`);
  return located;
}

/**
 * The directory a located executable lives in, or throws naming the program.
 *
 * @example
 * executableDirectory('cursor-agent', Bun.which('cursor-agent')); // '/home/ada/.local/bin'
 */
export function executableDirectory(program: string, located: string | null | undefined): string {
  return dirname(requiredExecutable(program, located));
}

/**
 * The data frames of a finished server-sent-events body, parsed.
 *
 * @example
 * sseFrames('data: {"type":"done"}\n\n'); // [{ type: 'done' }]
 */
export function sseFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
}

/**
 * The first dotted version in a `--version` line.
 *
 * @example
 * versionOf('codex-cli 0.150.0'); // '0.150.0'
 */
export function versionOf(line: string): string {
  const found = /\d+\.\d+\.\d+/.exec(line);
  if (!found) throw new Error(`expected a dotted version in the version line | received: ${line}`);
  return found[0];
}

/**
 * Whether dotted version `left` is older than `right`.
 *
 * @example
 * isOlderVersion('0.150.0', '0.154.0'); // true
 */
export function isOlderVersion(left: string, right: string): boolean {
  const parts = (version: string) => versionOf(version).split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

/**
 * Restricts discovery to one target, so a refusal case does not also probe the
 * two vendors it is not about. Satisfies the discovery service's client port.
 *
 * @example
 * createRuntimeAuthoritativeAgentDiscovery(() => Promise.resolve(new SingleTargetDiscovery(client, 'codex')));
 */
export class SingleTargetDiscovery {
  readonly manifest: RuntimeClient['manifest'];
  readonly externalAgents: Pick<RuntimeClient['externalAgents'], 'discover'>;

  constructor(client: RuntimeClient, targetId: ExternalAgentTargetId) {
    this.manifest = client.manifest;
    this.externalAgents = {
      discover: (params, options) =>
        client.externalAgents.discover({ ...params, targetIds: [targetId] }, options),
    };
  }
}

/**
 * The hub-side cheap pass, standing in for a scan of the machine: the target is
 * installed and looks signed in, which is what a descriptor cached before the
 * state changed would say. The runtime's own answer replaces it.
 *
 * @example
 * new CheapPassFake('codex').listAgentCliStatuses();
 */
export class CheapPassFake {
  constructor(private readonly targetId: ExternalAgentTargetId) {}

  listAgentCliStatuses(): Promise<AgentCliStatus[]> {
    const installation = {
      path: `/cheap-pass/${this.targetId}`,
      rawPath: `/cheap-pass/${this.targetId}`,
      version: '0.0.0',
      origin: 'path' as const,
      effective: true,
    };
    return Promise.resolve([
      {
        id: this.targetId,
        targetId: this.targetId,
        health: 'ok',
        installations: [installation],
        effective: installation,
        findings: [],
        installable: false,
        probedAtMs: 0,
        configHome: `/cheap-pass/.${this.targetId}`,
        configHomeExists: true,
        authenticated: true,
        authSignal: 'file-present',
        locations: [],
      } as unknown as AgentCliStatus,
    ]);
  }

  asService(): EnvironmentProbingService {
    return this as unknown as EnvironmentProbingService;
  }
}

/**
 * The descriptor as a selector cached before the refusal would still show it:
 * signed in, no reason, and a matrix with one supported pair. A send against it
 * passes the hub's preflight, so the runtime's own open is what refuses.
 *
 * @example
 * const cached = cachedBeforeRefusal(live);
 * cached.unavailableReason; // undefined
 */
export function cachedBeforeRefusal(live: ExternalAgentDescriptor): ExternalAgentDescriptor {
  const { unavailableReason: _reason, remedy: _remedy, requiredVersion: _required, ...rest } = live;
  return {
    ...rest,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, structuredStreaming: true },
    supportedConfigurations: [
      { level: 'default', routing: 'user', supported: true, unattended: false },
    ],
  };
}
