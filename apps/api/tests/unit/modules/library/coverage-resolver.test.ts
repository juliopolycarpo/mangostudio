import { describe, expect, it } from 'bun:test';

import type { LibraryInstance, LibraryLocationId } from '@mangostudio/shared/library';

import { resolveLibraryCoverage } from '../../../../src/modules/library/application/coverage-resolver';

function instance(locationId: LibraryLocationId): LibraryInstance {
  return {
    locationId,
    path: `/library/${locationId}/gh`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter',
    valid: true,
    contentHash: locationId,
    sizeBytes: 1,
  };
}

describe('resolveLibraryCoverage', () => {
  it('marks failed coverage without promoting a lower-precedence copy', () => {
    const coverage = resolveLibraryCoverage(
      { kind: 'skill', slug: 'gh' },
      [instance('agents-skills')],
      new Set<LibraryLocationId>(['codex-skills', 'claude-skills'])
    );

    expect(coverage.find(({ targetId }) => targetId === 'codex')).toEqual({
      targetId: 'codex',
      state: 'present',
      unscannedLocationIds: ['codex-skills'],
      shadowedLocationIds: [],
    });
    expect(coverage.find(({ targetId }) => targetId === 'claude')).toEqual({
      targetId: 'claude',
      state: 'absent',
      unscannedLocationIds: ['claude-skills'],
      shadowedLocationIds: [],
    });
    expect(coverage.find(({ targetId }) => targetId === 'mangostudio')).toMatchObject({
      effectiveLocationId: 'agents-skills',
      unscannedLocationIds: ['claude-skills'],
    });
    expect(coverage.find(({ targetId }) => targetId === 'cursor')).toEqual({
      targetId: 'cursor',
      state: 'absent',
      shadowedLocationIds: [],
    });
  });

  it('withholds shadowing when two observed copies have no verified winner', () => {
    const coverage = resolveLibraryCoverage(
      { kind: 'skill', slug: 'gh' },
      [instance('agents-skills'), instance('claude-skills')],
      new Set<LibraryLocationId>(['mango-skills'])
    );

    expect(coverage.find(({ targetId }) => targetId === 'mangostudio')).toEqual({
      targetId: 'mangostudio',
      state: 'present',
      unscannedLocationIds: ['mango-skills'],
      shadowedLocationIds: [],
    });
  });

  it('keeps the effective and shadowed copies when a lower-priority location fails', () => {
    const coverage = resolveLibraryCoverage(
      { kind: 'skill', slug: 'gh' },
      [instance('mango-skills'), instance('agents-skills')],
      new Set<LibraryLocationId>(['claude-skills'])
    );

    expect(coverage.find(({ targetId }) => targetId === 'mangostudio')).toEqual({
      targetId: 'mangostudio',
      state: 'shadowed',
      effectiveLocationId: 'mango-skills',
      shadowedLocationIds: ['agents-skills'],
      unscannedLocationIds: ['claude-skills'],
    });
  });

  it('uses each target precedence and reports lower copies as shadowed', () => {
    const coverage = resolveLibraryCoverage({ kind: 'skill', slug: 'gh' }, [
      instance('agents-skills'),
      instance('codex-skills'),
    ]);

    expect(coverage.find(({ targetId }) => targetId === 'codex')).toEqual({
      targetId: 'codex',
      state: 'shadowed',
      effectiveLocationId: 'codex-skills',
      shadowedLocationIds: ['agents-skills'],
    });
  });

  it('credits one shared instance to every target that reads it without duplicating it', () => {
    const instances = [instance('agents-skills')];
    const coverage = resolveLibraryCoverage({ kind: 'skill', slug: 'gh' }, instances);

    expect(instances).toHaveLength(1);
    expect(coverage.find(({ targetId }) => targetId === 'codex')?.state).toBe('present');
    expect(coverage.find(({ targetId }) => targetId === 'mangostudio')?.state).toBe('present');
  });

  it('reports absent when a resource exists only outside a target read set', () => {
    const coverage = resolveLibraryCoverage({ kind: 'skill', slug: 'gh' }, [
      instance('cursor-skills'),
    ]);

    expect(coverage.find(({ targetId }) => targetId === 'claude')).toEqual({
      targetId: 'claude',
      state: 'absent',
      shadowedLocationIds: [],
    });
  });

  it('preserves MangoStudio mango-agents-claude precedence', () => {
    const coverage = resolveLibraryCoverage({ kind: 'skill', slug: 'gh' }, [
      instance('claude-skills'),
      instance('agents-skills'),
      instance('mango-skills'),
    ]);

    expect(coverage.find(({ targetId }) => targetId === 'mangostudio')).toEqual({
      targetId: 'mangostudio',
      state: 'shadowed',
      effectiveLocationId: 'mango-skills',
      shadowedLocationIds: ['agents-skills', 'claude-skills'],
    });
  });
});
