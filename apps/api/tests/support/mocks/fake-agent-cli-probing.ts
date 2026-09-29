/**
 * A stand-in for the environment probing service's agent-CLI scan whose every
 * probe stays pending until the test settles it, so a test can observe what
 * callers do while a scan is in flight — and count how many scans they start.
 */

import type { AgentCliStatus } from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import type { AgentCliDetection } from '../../../src/modules/app-settings/application/detected-library-defaults';
import type { ProbeScope } from '../../../src/modules/environments/application/probing-service';

interface PendingProbe {
  readonly scope: ProbeScope;
  readonly resolve: (statuses: AgentCliStatus[]) => void;
  readonly reject: (error: Error) => void;
}

/** An installed CLI, shaped the way the runtime reports one. */
export function installedAgentCli(targetId: LibraryTargetId): AgentCliStatus {
  return { targetId, effective: { path: `/usr/local/bin/${targetId}` } } as AgentCliStatus;
}

/**
 * Records each `listAgentCliStatuses` call and holds it open.
 *
 * @example
 * const probing = new FakeAgentCliProbing();
 * const read = defaults.current();
 * probing.resolveProbe(0, [installedAgentCli('codex')]);
 */
export class FakeAgentCliProbing implements AgentCliDetection {
  readonly #probes: PendingProbe[] = [];

  /** How many scans callers started. */
  get probeCount(): number {
    return this.#probes.length;
  }

  /** The scope each scan was asked for, in call order. */
  get scopes(): readonly ProbeScope[] {
    return this.#probes.map((probe) => probe.scope);
  }

  listAgentCliStatuses(scope: ProbeScope): Promise<AgentCliStatus[]> {
    return new Promise((resolve, reject) => {
      this.#probes.push({ scope, resolve, reject });
    });
  }

  /** Answers scan number `index` (0-based) with these installed CLIs. */
  resolveProbe(index: number, statuses: AgentCliStatus[]): void {
    this.#probe(index).resolve(statuses);
  }

  /** Fails scan number `index` (0-based), the way a runtime that never came up does. */
  rejectProbe(index: number, error: Error): void {
    this.#probe(index).reject(error);
  }

  #probe(index: number): PendingProbe {
    const probe = this.#probes[index];
    if (!probe) {
      throw new Error(
        `expected probe index: 0..${this.#probes.length - 1} | received: ${index} (no such probe started)`
      );
    }
    return probe;
  }
}
