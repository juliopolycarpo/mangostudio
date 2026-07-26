import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  isValidResourceSlug,
  LIBRARY_RESOURCE_SLUG_MAX_LENGTH,
  LibraryResourceRefSchema,
  LibraryResourceSchema,
  parseResourceKey,
  type ResourceKind,
  resourceKey,
  SKILL_SOURCE_TO_LOCATION_ID,
} from '../../../src/library';
import { SkillSourceSchema } from '../../../src/skills';

const RESOURCE_KINDS: ReadonlyArray<ResourceKind> = [
  'skill',
  'subagent',
  'instruction',
  'setting',
  'hook',
];

describe('library resource keys', () => {
  it('round-trips every resource kind', () => {
    for (const kind of RESOURCE_KINDS) {
      const key = resourceKey(kind, 'shared-resource');
      expect(parseResourceKey(key)).toEqual({ kind, slug: 'shared-resource' });
    }
  });

  it.each([
    'path/child',
    'path\\child',
    'path..child',
    '.hidden',
    '..',
    'trailing.',
    'stream:name',
    'has space',
    'line\nbreak',
    'a'.repeat(LIBRARY_RESOURCE_SLUG_MAX_LENGTH + 1),
  ])('rejects unsafe slug %s', (slug) => {
    expect(isValidResourceSlug(slug)).toBe(false);
    expect(() => resourceKey('skill', slug)).toThrow(TypeError);
    expect(parseResourceKey(`skill:${slug}`)).toBeNull();
    expect(Value.Check(LibraryResourceRefSchema, { kind: 'skill', slug })).toBe(false);
  });

  it.each([
    'gh',
    'settings.local',
    'AGENTS',
    'multi-word_slug',
  ])('accepts path-safe slug %s', (slug) => {
    expect(isValidResourceSlug(slug)).toBe(true);
    expect(Value.Check(LibraryResourceRefSchema, { kind: 'skill', slug })).toBe(true);
  });

  it('rejects unknown kinds and malformed keys', () => {
    expect(parseResourceKey('unknown:resource')).toBeNull();
    expect(parseResourceKey('skill')).toBeNull();
    expect(parseResourceKey('skill:')).toBeNull();
  });
});

describe('library resource contracts', () => {
  it('validates the peer model without assigning a canonical instance', () => {
    expect(
      Value.Check(LibraryResourceSchema, {
        ref: { kind: 'skill', slug: 'gh' },
        key: 'skill:gh',
        instances: [
          {
            locationId: 'agents-skills',
            path: '/home/user/.agents/skills/gh',
            contentHash: 'a'.repeat(64),
            sizeBytes: 512,
            modifiedAtMs: 1_700_000_000_000,
            format: 'markdown-frontmatter',
            valid: true,
            title: 'GitHub',
          },
        ],
        coverage: [
          {
            targetId: 'codex',
            state: 'present',
            effectiveLocationId: 'agents-skills',
            shadowedLocationIds: [],
          },
        ],
        divergence: 'single',
        contentGroups: [
          {
            contentHash: 'a'.repeat(64),
            locationIds: ['agents-skills'],
            instanceCount: 1,
          },
        ],
      })
    ).toBe(true);
  });
});

describe('skill source migration mapping', () => {
  it('maps every legacy skill source to one library location', () => {
    const sources = SkillSourceSchema.anyOf.map((source) => source.const);

    expect(sources.map((source) => SKILL_SOURCE_TO_LOCATION_ID[source])).toEqual([
      'mango-skills',
      'agents-skills',
      'claude-skills',
    ]);
  });
});
