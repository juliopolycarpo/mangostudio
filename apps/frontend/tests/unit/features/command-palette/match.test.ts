/**
 * The palette's ranking. Every assertion here is about an ordering a user can
 * feel: the thing you typed the start of comes first, the sections never
 * reshuffle, and an empty query is a recents list rather than everything.
 */

import { describe, expect, it } from 'bun:test';
import type { CommandItem } from '../../../../src/features/command-palette/lib/command-item';
import {
  matchScore,
  rankCommands,
  scoreCommand,
} from '../../../../src/features/command-palette/lib/match';

function item(overrides: Partial<CommandItem> & { id: string; label: string }): CommandItem {
  return {
    section: 'actions',
    run: () => undefined,
    ...overrides,
  };
}

describe('matchScore', () => {
  it('orders exact above prefix above word start above substring above subsequence', () => {
    const exact = matchScore('git', 'git');
    const prefix = matchScore('git commit messages', 'git');
    const wordStart = matchScore('Settings · Git', 'git');
    const substring = matchScore('digital', 'git');
    const subsequence = matchScore('generate images tab', 'git');

    expect(exact).toBeGreaterThan(prefix as number);
    expect(prefix).toBeGreaterThan(wordStart as number);
    expect(wordStart).toBeGreaterThan(substring as number);
    expect(substring).toBeGreaterThan(subsequence as number);
  });

  it('prefers the shorter label when both are prefix matches', () => {
    expect(matchScore('Git', 'git')).toBeGreaterThan(matchScore('Git commit messages', 'git') ?? 0);
  });

  it('prefers the tighter run when both are subsequences', () => {
    const tight = matchScore('command palette', 'cmdp');
    const scattered = matchScore('cannot mind deeply the peculiar', 'cmdp');
    expect(tight).toBeGreaterThan(scattered as number);
  });

  it('returns null when the characters are not there in order', () => {
    expect(matchScore('gallery', 'zzz')).toBeNull();
    expect(matchScore('gallery', 'yrellag')).toBeNull();
  });

  it('ignores case and diacritics, so pt-BR titles are reachable from an ASCII keyboard', () => {
    expect(matchScore('Configurações', 'configuracoes')).not.toBeNull();
    expect(matchScore('Sessão de revisão', 'sessao')).not.toBeNull();
  });

  it('scores every text the same for an empty query, leaving the caller order intact', () => {
    expect(matchScore('anything', '')).toBe(0);
    expect(matchScore('something else', '   ')).toBe(0);
  });
});

describe('scoreCommand', () => {
  it('ranks any label match above any hint or keyword match', () => {
    const byLabel = scoreCommand(item({ id: 'a', label: 'mango-lsp-store' }), 'mango');
    const byKeyword = scoreCommand(
      item({ id: 'b', label: 'Unrelated title', keywords: 'mango' }),
      'mango'
    );
    const byHint = scoreCommand(
      item({ id: 'c', label: 'Unrelated title', hint: 'mango' }),
      'mango'
    );
    expect(byLabel).toBeGreaterThan(byKeyword as number);
    expect(byLabel).toBeGreaterThan(byHint as number);
  });

  it('finds a row by the hint it renders and by its hidden keywords alike', () => {
    expect(scoreCommand(item({ id: 'a', label: 'Untitled', keywords: 'codex' }), 'codex')).not.toBe(
      null
    );
    expect(scoreCommand(item({ id: 'b', label: 'Gallery', hint: '/gallery' }), '/gal')).not.toBe(
      null
    );
    expect(scoreCommand(item({ id: 'c', label: 'Untitled' }), 'codex')).toBeNull();
  });
});

describe('rankCommands', () => {
  const registry: CommandItem[] = [
    item({ id: 's1', section: 'sessions', label: 'Session one' }),
    item({ id: 's2', section: 'sessions', label: 'Session two' }),
    item({ id: 's3', section: 'sessions', label: 'Session three' }),
    // Matches "git" only as a substring of "digit" — the weakest tier that
    // still matches, so the navigate row below outscores it.
    item({ id: 's4', section: 'sessions', label: 'Refactoring the digit parser' }),
    item({ id: 'a1', section: 'actions', label: 'New Chat' }),
    item({ id: 'n1', section: 'navigate', label: 'Settings · Git' }),
    item({ id: 'e1', section: 'environments', label: 'Local' }),
  ];

  const sections = (query: string) =>
    rankCommands(registry, query).groups.map((group) => group.section);

  it('keeps the section order fixed regardless of what scored best', () => {
    // "git" scores higher in navigate, but navigate does not jump the queue.
    expect(sections('git')).toEqual(['sessions', 'navigate']);
    expect(sections('')).toEqual(['sessions', 'actions', 'navigate', 'environments']);
  });

  it('drops sections with no match rather than rendering an empty heading', () => {
    expect(sections('local')).toEqual(['environments']);
  });

  it('points the cursor at the best match anywhere, not at the first row on screen', () => {
    const { flat, bestIndex } = rankCommands(registry, 'git');
    // The session is listed first because sections are fixed; the settings tab
    // is the better answer, so that is what Enter would run.
    expect(flat[0].id).toBe('s4');
    expect(flat[bestIndex].id).toBe('n1');
  });

  it('opens on the most recent session when nothing has been typed', () => {
    const { flat, bestIndex } = rankCommands(registry, '');
    expect(bestIndex).toBe(0);
    expect(flat[0].id).toBe('s1');
  });

  it('reports no cursor at all when nothing matched', () => {
    const ranked = rankCommands(registry, 'zzzqqq');
    expect(ranked.flat).toHaveLength(0);
    expect(ranked.bestIndex).toBe(-1);
  });

  it('caps sessions at the recents limit while the query is empty', () => {
    const { groups } = rankCommands(registry, '', { recentSessionLimit: 2 });
    expect(groups[0].section).toBe('sessions');
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['s1', 's2']);
  });

  it('lifts the cap as soon as something is typed — a search must not hide matches', () => {
    const { groups } = rankCommands(registry, 'session', { recentSessionLimit: 2 });
    expect(groups[0].items).toHaveLength(3);
  });

  it('breaks score ties on the order the provider returned, which is recency', () => {
    const { groups } = rankCommands(registry, 'Session', { recentSessionLimit: 10 });
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['s1', 's2', 's3']);
  });
});
