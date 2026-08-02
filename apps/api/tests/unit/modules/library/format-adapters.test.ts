import { describe, expect, it } from 'bun:test';
import type { AdapterStrategy } from '@mangostudio/shared/library';
import {
  LIBRARY_LOCATION_DEFINITIONS,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import {
  createDefaultAdapterRegistry,
  FormatAdapterRegistry,
  rankAdapterStrategies,
} from '../../../../src/modules/library/application/adapters/registry';

describe('default format adapter registry', () => {
  it('copies bytes verbatim between identical formats', () => {
    const registry = createDefaultAdapterRegistry();

    expect(
      registry.strategiesFor({
        kind: 'instruction',
        from: 'markdown-plain',
        to: 'markdown-plain',
      })
    ).toEqual(['verbatim']);
  });

  it('offers deterministic adapters and hides model adapters when no model is available', () => {
    const registry = createDefaultAdapterRegistry();

    expect(
      registry.strategiesFor({
        kind: 'instruction',
        from: 'markdown-plain',
        to: 'mdc',
      })
    ).toEqual(['mechanical']);
    expect(
      registry.strategiesFor({
        kind: 'instruction',
        from: 'markdown-plain',
        to: 'rules-dsl',
      })
    ).toEqual([]);
    expect(
      registry.strategiesFor({
        kind: 'instruction',
        from: 'markdown-plain',
        to: 'rules-dsl',
        agentAvailable: true,
      })
    ).toEqual(['agent']);
  });

  it('normalizes same-format subagents only when their target dialect differs', () => {
    const registry = createDefaultAdapterRegistry();

    expect(
      registry.strategiesFor({
        kind: 'subagent',
        from: 'markdown-frontmatter',
        to: 'markdown-frontmatter',
        sourceLocationId: 'claude-agents',
        targetLocationId: 'claude-agents',
      })
    ).toEqual(['verbatim']);
    expect(
      registry.strategiesFor({
        kind: 'subagent',
        from: 'markdown-frontmatter',
        to: 'markdown-frontmatter',
        sourceLocationId: 'claude-agents',
        targetLocationId: 'cursor-agents',
      })
    ).toEqual(['mechanical']);
  });

  it('hides an agent alternative when a deterministic adapter exists unless requested', () => {
    const registry = new FormatAdapterRegistry()
      .register(testAdapter('mechanical'))
      .register(testAdapter('agent'));
    const query = {
      kind: 'instruction' as const,
      from: 'markdown-plain' as const,
      to: 'mdc' as const,
      agentAvailable: true,
    };

    expect(registry.strategiesFor(query)).toEqual(['mechanical']);
    expect(registry.strategiesFor({ ...query, agentRequested: true })).toEqual([
      'mechanical',
      'agent',
    ]);
  });

  it('marks every reachable same-kind format pair supported or explicitly unsupported', () => {
    const registry = createDefaultAdapterRegistry();
    const reachablePairs = LIBRARY_LOCATION_DEFINITIONS.flatMap((source) =>
      LIBRARY_LOCATION_DEFINITIONS.flatMap((target) =>
        source.kind === target.kind ? [[source, target] as const] : []
      )
    );

    for (const [source, target] of reachablePairs) {
      expect(
        registry.coverageFor(source.kind, source.format, target.format),
        pairName(source, target)
      ).not.toBe('missing');
    }
  });

  it('rejects duplicate strategies for one kind and format pair', () => {
    const registry = new FormatAdapterRegistry();
    const adapter = testAdapter('verbatim', 'markdown-plain');

    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow('Duplicate verbatim adapter');
  });
});

describe('rankAdapterStrategies', () => {
  it('orders strategies most faithful first and recommends that one', () => {
    expect(rankAdapterStrategies(['agent', 'mechanical', 'verbatim'])).toEqual({
      available: ['verbatim', 'mechanical', 'agent'],
      recommended: 'verbatim',
    });
  });

  it('recommends nothing when no strategy applies', () => {
    expect(rankAdapterStrategies([])).toEqual({ available: [] });
  });

  it('ignores duplicates so a catalog cannot skew the ordering', () => {
    expect(rankAdapterStrategies(['agent', 'agent', 'mechanical'])).toEqual({
      available: ['mechanical', 'agent'],
      recommended: 'mechanical',
    });
  });
});

function pairName(source: LocationDefinition, target: LocationDefinition): string {
  return `${source.kind}: ${source.id} (${source.format}) -> ${target.id} (${target.format})`;
}

function testAdapter(strategy: AdapterStrategy, to: 'markdown-plain' | 'mdc' = 'mdc') {
  return {
    kind: 'instruction' as const,
    from: 'markdown-plain' as const,
    to,
    strategy,
    lossy: strategy === 'agent',
    adapt: () => ({
      ok: true as const,
      content: 'same',
      notes: [],
      requiresReview: strategy === 'agent',
      lossy: strategy === 'agent',
    }),
  };
}
