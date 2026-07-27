import { describe, expect, it } from 'bun:test';
import type { LibraryInstance, LibraryLocationId } from '@mangostudio/shared/library';
import {
  describeDivergence,
  type InstanceComparison,
} from '../../../../src/modules/library/application/divergence';

function compared(
  locationId: LibraryLocationId,
  contentHash: string,
  whitespaceHash = contentHash
): InstanceComparison {
  const instance: LibraryInstance = {
    locationId,
    path: `/library/${locationId}/gh`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter',
    valid: true,
    contentHash,
    sizeBytes: 1,
  };
  return { instance, whitespaceHash };
}

describe('describeDivergence', () => {
  it('groups hashes with the majority first without treating it as canonical', () => {
    const result = describeDivergence('skill', [
      compared('mango-skills', 'same'),
      compared('agents-skills', 'same'),
      compared('claude-skills', 'same'),
      compared('cursor-skills', 'different'),
    ]);

    expect(result.divergence).toBe('divergent');
    expect(result.contentGroups.map((group) => group.instanceCount)).toEqual([3, 1]);
    expect(result.contentGroups[0]?.locationIds).toEqual([
      'agents-skills',
      'claude-skills',
      'mango-skills',
    ]);
  });

  it('describes uniform and single-instance resources independently', () => {
    expect(
      describeDivergence('skill', [
        compared('mango-skills', 'same'),
        compared('agents-skills', 'same'),
      ]).divergence
    ).toBe('uniform');
    expect(describeDivergence('skill', [compared('mango-skills', 'only')]).divergence).toBe(
      'single'
    );
  });

  it('does not describe an unhashable copy as identical content', () => {
    const unreadable: LibraryInstance = {
      locationId: 'agents-skills',
      path: '/library/agents-skills/gh',
      modifiedAtMs: 1,
      format: 'markdown-frontmatter',
      valid: false,
      invalidReason: 'unreadable',
    };

    expect(
      describeDivergence('skill', [compared('mango-skills', 'known'), { instance: unreadable }])
        .divergence
    ).toBe('single');
  });

  it('withholds a verdict for kinds no target can write', () => {
    const result = describeDivergence('hook', [
      compared('claude-hooks', 'claude-settings-json'),
      compared('codex-hooks', 'codex-hooks-json'),
    ]);

    expect(result.divergence).toBe('not-comparable');
    expect(result.whitespaceOnlyDivergence).toBe(false);
    expect(result.contentGroups).toHaveLength(2);
  });

  it('flags byte divergence that disappears after whitespace removal', () => {
    const result = describeDivergence('skill', [
      compared('mango-skills', 'lf', 'normalized'),
      compared('agents-skills', 'spaces', 'normalized'),
    ]);

    expect(result.divergence).toBe('divergent');
    expect(result.whitespaceOnlyDivergence).toBe(true);
  });
});
