import type {
  ExternalAgentCapabilities,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { RuntimeToolArgumentError } from '../../errors';
import type { ExternalAgentAdapter } from './adapter';

const OPTIONAL_CAPABILITIES = {
  steering: 'steer',
  sessionListing: 'listSessions',
  nativeReview: 'startReview',
  accountUsage: 'refreshAccountUsage',
} as const satisfies Readonly<
  Record<
    'steering' | 'sessionListing' | 'nativeReview' | 'accountUsage',
    keyof ExternalAgentAdapter
  >
>;

/** Immutable target registry; the manifest and dispatch both read this instance. */
export class ExternalAgentAdapterRegistry {
  readonly #adapters = new Map<ExternalAgentTargetId, ExternalAgentAdapter>();

  constructor(adapters: readonly ExternalAgentAdapter[] = []) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.targetId)) {
        throw new Error(`External-agent adapter "${adapter.targetId}" is registered twice.`);
      }
      this.#adapters.set(adapter.targetId, adapter);
    }
  }

  get targetIds(): readonly ExternalAgentTargetId[] {
    return [...this.#adapters.keys()].sort();
  }

  get(targetId: ExternalAgentTargetId): ExternalAgentAdapter | undefined {
    return this.#adapters.get(targetId);
  }

  require(targetId: ExternalAgentTargetId): ExternalAgentAdapter {
    const adapter = this.get(targetId);
    if (!adapter) {
      throw new RuntimeToolArgumentError(
        `External-agent target "${targetId}" is not supported by this runtime.`
      );
    }
    return adapter;
  }
}

/** Refuses descriptors whose advertised optional surface cannot be called. */
export function assertExternalAgentAdapterConformance(
  adapter: ExternalAgentAdapter,
  capabilities: ExternalAgentCapabilities
): void {
  for (const [capability, member] of Object.entries(OPTIONAL_CAPABILITIES) as Array<
    [
      keyof typeof OPTIONAL_CAPABILITIES,
      (typeof OPTIONAL_CAPABILITIES)[keyof typeof OPTIONAL_CAPABILITIES],
    ]
  >) {
    const implemented = typeof adapter[member] === 'function';
    // One direction only. Method presence is fixed per adapter class while
    // capabilities are discovered per machine, so an adapter that implements
    // `steer` may still meet a CLI build that cannot steer and has to report
    // `steering: false`. Advertising what cannot be called is the bug.
    if (capabilities[capability] && !implemented) {
      throw new Error(
        `External-agent adapter "${adapter.targetId}" advertises ${capability}=true but ${String(member)} is missing.`
      );
    }
  }
}
