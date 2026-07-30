/**
 * Identity resolution and the avatar palette.
 *
 * The contrast assertion is the reason the palette holds literal colours rather
 * than design tokens: a monogram has to stay readable on its chip in both
 * themes, and only real values can be measured.
 */

import type { ToolIdentityMap } from '@mangostudio/shared/tool-identity';
import { describe, expect, it } from 'vitest';
import {
  TOOL_AVATAR_PALETTE,
  type ToolAvatarColors,
  toolAvatarPalette,
} from '../../../../src/components/ui/tool-avatar-palette';
import {
  deriveMonogram,
  resolveToolIdentity,
} from '../../../../src/features/environments/identity/resolve';

/** WCAG 2.1 AA for normal-size text. */
const AA_CONTRAST = 4.5;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((rgb >> 16) & 255) +
    0.7152 * channelLuminance((rgb >> 8) & 255) +
    0.0722 * channelLuminance(rgb & 255)
  );
}

function contrastRatio({ bg, fg }: ToolAvatarColors): number {
  const [lighter, darker] = [relativeLuminance(bg), relativeLuminance(fg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function identityMap(entries: Record<string, { displayName?: string; monogram?: string }>) {
  return Object.fromEntries(
    Object.entries(entries).map(([subjectKey, value]) => [
      subjectKey,
      {
        subjectKey,
        displayName: value.displayName ?? null,
        monogram: value.monogram ?? null,
        updatedAt: 1,
      },
    ])
  ) as ToolIdentityMap;
}

describe('deriveMonogram', () => {
  it('takes the initials of the first two words', () => {
    expect(deriveMonogram('Claude Code')).toBe('CC');
    // A third word is not a third letter.
    expect(deriveMonogram('Visual Studio Code')).toBe('VS');
  });

  it('takes the first two characters of a single word', () => {
    expect(deriveMonogram('Bun')).toBe('BU');
    expect(deriveMonogram('nvm')).toBe('NV');
    expect(deriveMonogram('Node.js')).toBe('NO');
  });

  it('uppercases diacritics without dropping them', () => {
    expect(deriveMonogram('ação rápida')).toBe('AR');
    expect(deriveMonogram('émulateur')).toBe('ÉM');
  });

  it('falls back to the first two characters for scripts without word breaks', () => {
    expect(deriveMonogram('日本語')).toBe('日本');
  });

  it('never returns more than two characters, even when uppercasing lengthens', () => {
    // "ß".toUpperCase() is "SS": uppercasing can add characters, so the result
    // is re-trimmed rather than trusted.
    expect(Array.from(deriveMonogram('ßeta'))).toHaveLength(2);
    expect(Array.from(deriveMonogram('🥭 studio'))).toHaveLength(2);
  });

  it('degrades to a placeholder rather than rendering an empty chip', () => {
    expect(deriveMonogram('   ')).toBe('?');
  });
});

describe('resolveToolIdentity', () => {
  it('falls back to the product name when nothing is stored', () => {
    const resolved = resolveToolIdentity({}, 'agent:claude', 'Claude Code');

    expect(resolved.name).toBe('Claude Code');
    expect(resolved.monogram).toBe('CC');
    expect(resolved.customized).toBe(false);
  });

  it('prefers the custom name and derives the monogram from it', () => {
    const identities = identityMap({ 'agent:claude': { displayName: 'My Agent' } });
    const resolved = resolveToolIdentity(identities, 'agent:claude', 'Claude Code');

    expect(resolved.name).toBe('My Agent');
    expect(resolved.monogram).toBe('MA');
    expect(resolved.customized).toBe(true);
  });

  it('keeps an explicit monogram across a rename', () => {
    const identities = identityMap({
      'agent:claude': { displayName: 'My Agent', monogram: 'ZZ' },
    });

    expect(resolveToolIdentity(identities, 'agent:claude', 'Claude Code').monogram).toBe('ZZ');
  });

  it('keeps an entry for another subject from leaking in', () => {
    const identities = identityMap({ 'runtime:claude': { displayName: 'Renamed runtime' } });

    expect(resolveToolIdentity(identities, 'agent:claude', 'Claude Code').name).toBe('Claude Code');
  });
});

describe('toolAvatarPalette', () => {
  it('gives a known tool the same colour under every kind', () => {
    // `agent:claude` and `runtime:claude` are one tool seen from two tabs.
    expect(toolAvatarPalette('agent:claude').slot).toBe(toolAvatarPalette('runtime:claude').slot);
    expect(toolAvatarPalette('agent:claude').slot).toBe('orange');
    expect(toolAvatarPalette('agent:codex').slot).toBe('teal');
    expect(toolAvatarPalette('agent:cursor').slot).toBe('violet');
    expect(toolAvatarPalette('runtime:bun').slot).toBe('amber');
    expect(toolAvatarPalette('runtime:node').slot).toBe('green');
  });

  it('is deterministic for unknown subjects', () => {
    const first = toolAvatarPalette('mcp:weather');

    expect(toolAvatarPalette('mcp:weather')).toEqual(first);
    expect(TOOL_AVATAR_PALETTE).toContainEqual(first);
  });

  it('spreads unknown subjects across more than one slot', () => {
    const slots = new Set(
      ['mcp:weather', 'mcp:github', 'mcp:linear', 'mcp:notion', 'mcp:slack'].map(
        (key) => toolAvatarPalette(key).slot
      )
    );

    expect(slots.size).toBeGreaterThan(1);
  });

  it('renders a colour rather than nothing for a malformed key', () => {
    expect(TOOL_AVATAR_PALETTE).toContainEqual(toolAvatarPalette('nonsense'));
  });
});

describe('tool avatar palette contrast', () => {
  it('clears WCAG AA in both themes for every slot', () => {
    for (const palette of TOOL_AVATAR_PALETTE) {
      expect(contrastRatio(palette.dark), `${palette.slot} (dark)`).toBeGreaterThanOrEqual(
        AA_CONTRAST
      );
      expect(contrastRatio(palette.light), `${palette.slot} (light)`).toBeGreaterThanOrEqual(
        AA_CONTRAST
      );
    }
  });

  it('keeps every slot distinct', () => {
    const slots = TOOL_AVATAR_PALETTE.map((palette) => palette.slot);

    expect(new Set(slots).size).toBe(slots.length);
  });
});
