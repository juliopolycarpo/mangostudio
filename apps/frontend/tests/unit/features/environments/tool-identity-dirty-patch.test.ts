import { describe, expect, it } from 'bun:test';

import type { ToolImage } from '@mangostudio/shared/tool-identity';

import { buildToolIdentityPatch } from '../../../../src/features/environments/identity/dirty-patch';
import { resolveToolIdentity } from '../../../../src/features/environments/identity/resolve';

const draft = {
  name: 'Original',
  monogram: 'OR',
  imageMode: 'monogram' as const,
  imageUrl: '',
  cacheImage: true,
};

function opening(image: ToolImage | null = null) {
  return resolveToolIdentity(
    {
      'agent:claude': {
        subjectKey: 'agent:claude',
        displayName: 'Original',
        monogram: 'OR',
        image,
        updatedAt: 1,
      },
    },
    'agent:claude',
    'Claude Code'
  );
}

describe('buildToolIdentityPatch', () => {
  it('normalizes text before comparing and sending', () => {
    expect(
      buildToolIdentityPatch(opening(), { ...draft, name: ' Original ', monogram: 'or' })
    ).toEqual({});
    expect(buildToolIdentityPatch(opening(), { ...draft, name: ' New ', monogram: 'zz' })).toEqual({
      displayName: 'New',
      monogram: 'ZZ',
    });
  });

  it('keeps explicit clears and omits already empty overrides', () => {
    expect(buildToolIdentityPatch(opening(), { ...draft, name: ' ', monogram: '' })).toEqual({
      displayName: null,
      monogram: null,
    });
    const empty = resolveToolIdentity({}, 'agent:claude', 'Claude Code');
    expect(buildToolIdentityPatch(empty, { ...draft, name: '', monogram: '' })).toEqual({});
  });

  it('clears a stored image only when choosing no image', () => {
    const identity = opening({ source: 'upload', url: null, cached: true });
    expect(buildToolIdentityPatch(identity, draft)).toEqual({ image: null });
    expect(buildToolIdentityPatch(identity, { ...draft, imageMode: 'upload' })).toEqual({});
  });

  it('compares URL and cache preference without comparing byte versions', () => {
    const identity = opening({
      source: 'url',
      url: 'https://example.com/a.webp',
      cached: true,
      cacheKey: 'opening',
    });
    const urlDraft = {
      ...draft,
      imageMode: 'url' as const,
      imageUrl: ' https://example.com/a.webp ',
    };
    expect(buildToolIdentityPatch(identity, urlDraft)).toEqual({});
    expect(buildToolIdentityPatch(identity, { ...urlDraft, cacheImage: false })).toEqual({
      image: { source: 'url', url: 'https://example.com/a.webp', cache: false },
    });
    expect(
      buildToolIdentityPatch(identity, { ...urlDraft, imageUrl: 'https://example.com/b.webp' })
    ).toEqual({ image: { source: 'url', url: 'https://example.com/b.webp', cache: true } });
    expect(buildToolIdentityPatch(opening(), urlDraft)).toEqual({
      image: { source: 'url', url: 'https://example.com/a.webp', cache: true },
    });
  });
});
