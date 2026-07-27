import type { AdapterStrategy, ResourceFormat } from '@mangostudio/shared/library';

/**
 * Answers which strategies can rewrite one resource format into another.
 *
 * The default catalog knows only the identity case, so a destination whose
 * format differs from the source has no strategy and propagation reports it
 * `blocked` rather than guessing at a conversion. Format adapters are their own
 * piece of work; this seam is what they plug into, and it exists now so the
 * preview's classification is written once against a stable shape.
 */
export interface AdapterCatalog {
  strategiesFor(from: ResourceFormat, to: ResourceFormat): readonly AdapterStrategy[];
}

/**
 * Most faithful first. A verbatim copy is always preferable to a transform, and
 * a deterministic transform is always preferable to a model-drafted one.
 */
const STRATEGY_PREFERENCE: readonly AdapterStrategy[] = ['verbatim', 'mechanical', 'agent'];

export const defaultAdapterCatalog: AdapterCatalog = {
  strategiesFor: (from, to) => (from === to ? ['verbatim'] : []),
};

/** Orders strategies most-faithful first and names the one to preselect. */
export function rankAdapterStrategies(strategies: readonly AdapterStrategy[]): {
  readonly available: AdapterStrategy[];
  readonly recommended?: AdapterStrategy;
} {
  const offered = new Set(strategies);
  const available = STRATEGY_PREFERENCE.filter((strategy) => offered.has(strategy));
  const [recommended] = available;
  return { available, ...(recommended !== undefined && { recommended }) };
}
