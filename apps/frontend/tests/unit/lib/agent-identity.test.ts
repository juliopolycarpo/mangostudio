/**
 * The sidebar dot, the composer frame and the hub pill all colour from this
 * one table. They used to hold three copies of it, so a vendor added to two of
 * them rendered in two different colours until the third landed.
 */

import { describe, expect, it } from 'bun:test';
import { agentIdentityTokens, MANGO_IDENTITY } from '../../../src/lib/agent-identity';

describe('agentIdentityTokens', () => {
  it('gives a known target its own colour in both forms', () => {
    expect(agentIdentityTokens('codex')).toEqual({
      dotClass: 'bg-agent-codex',
      colorVar: 'var(--color-agent-codex)',
    });
  });

  it('falls back to the neutral harness colour for a target this bundle predates', () => {
    expect(agentIdentityTokens('some-future-cli')).toEqual({
      dotClass: 'bg-agent-generic',
      colorVar: 'var(--color-agent-generic)',
    });
  });

  it('keeps MangoStudio out of the external table so it cannot be a fallback', () => {
    expect(MANGO_IDENTITY.dotClass).toBe('bg-agent-mango');
    expect(agentIdentityTokens('mango').dotClass).toBe('bg-agent-generic');
  });

  /**
   * Tailwind scans source text for class names, so a class assembled from a
   * template literal is never generated and the dot renders transparent.
   */
  it('spells every dot class out in full', () => {
    for (const targetId of ['codex', 'claude', 'cursor', 'unknown']) {
      expect(agentIdentityTokens(targetId).dotClass).toMatch(/^bg-agent-[a-z]+$/);
    }
  });
});
