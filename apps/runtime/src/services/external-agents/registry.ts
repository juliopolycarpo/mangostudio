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
    if (capabilities[capability] !== implemented) {
      throw new Error(
        `External-agent adapter "${adapter.targetId}" advertises ${capability}=${capabilities[capability]} but ${String(member)} is ${implemented ? 'implemented' : 'missing'}.`
      );
    }
  }
}
