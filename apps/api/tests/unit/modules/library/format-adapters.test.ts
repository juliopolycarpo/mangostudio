import { describe, expect, it } from 'bun:test';
import {
  defaultAdapterCatalog,
  rankAdapterStrategies,
} from '../../../../src/modules/library/domain/format-adapters';

describe('defaultAdapterCatalog', () => {
  it('copies bytes verbatim between identical formats', () => {
    expect(defaultAdapterCatalog.strategiesFor('markdown-plain', 'markdown-plain')).toEqual([
      'verbatim',
    ]);
  });

  it('offers nothing across formats, so propagation blocks instead of guessing', () => {
    expect(defaultAdapterCatalog.strategiesFor('markdown-plain', 'mdc')).toEqual([]);
    expect(defaultAdapterCatalog.strategiesFor('markdown-frontmatter', 'toml-agent')).toEqual([]);
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
