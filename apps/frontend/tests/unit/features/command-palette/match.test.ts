/**
 * The palette's ranking. Every assertion here is about an ordering a user can
 * feel: the thing you typed the start of comes first, the sections never
 * reshuffle, and an empty query is a recents list rather than everything.
 */

import { describe, expect, it } from 'bun:test';

import type { CommandItem } from '../../../../src/features/command-palette/lib/command-item';
import {
  activeCommandIndex,
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
    const subsequence = matchScore('gain it', 'git');

    expect(exact).toBeGreaterThan(prefix as number);
    expect(prefix).toBeGreaterThan(wordStart as number);
    expect(wordStart).toBeGreaterThan(substring as number);
    expect(substring).toBeGreaterThan(subsequence as number);
  });

  it('prefers the shorter label when both are prefix matches', () => {
    expect(matchScore('Git', 'git')).toBeGreaterThan(matchScore('Git commit messages', 'git') ?? 0);
  });

  it('prefers the tighter run when both are subsequences', () => {
    const tight = matchScore('cmd palette', 'cmdp');
    const looser = matchScore('command palette', 'cmdp');
    expect(looser).not.toBeNull();
    expect(tight).toBeGreaterThan(looser as number);
  });

  it('measures the tightest span, not the one starting at the first character', () => {
    // `abc` matches from either `a`. Scoring the earliest one spans nine
    // characters; the later `a…b…c` is four wide and is what the tier is meant
    // to reward.
    const tightSpanLater = matchScore('abxxxaxbc', 'abc');
    expect(tightSpanLater).toBe(matchScore('axbc', 'abc'));
    // Same first-character position, but no second start to find — scoring from
    // the first `a` alone would give these two the same score.
    expect(tightSpanLater).toBeGreaterThan(matchScore('abxxxxxxc', 'abc') as number);
  });

  describe('a scattered subsequence', () => {
    it('still reaches an abbreviation of a label', () => {
      expect(matchScore('command palette', 'cmdp')).not.toBeNull();
    });

    it('is not a match when the letters merely occur in order somewhere in a long title', () => {
      // The screenshot that prompted the bound: four letters, found in order
      // across a whole sentence, listed above the Settings tabs they are not.
      expect(matchScore('Postgres connection pooling notes', 'sett')).toBeNull();
      expect(matchScore('Move the sidebar rows to flat tokens', 'sett')).toBeNull();
    });

    it('needs three letters, because two always find something', () => {
      expect(matchScore('gain it', 'gt')).toBeNull();
      expect(matchScore('gain it', 'git')).not.toBeNull();
    });

    it('stops at three times the query length', () => {
      // `git` allows a run of nine: g…i…t at nine characters is in, ten is out.
      expect(matchScore('gaaaaaait', 'git')).not.toBeNull();
      expect(matchScore('gaaaaaaait', 'git')).toBeNull();
    });
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

  it('reads the hint and keywords literally, never as scattered letters', () => {
    // `mgs` is a subsequence of the hint, and of nothing a person would call
    // the folder: a path is found by what it contains, not by its consonants.
    const row = item({ id: 'a', label: 'Untitled', hint: 'mangostudio', keywords: 'codex' });
    expect(scoreCommand(row, 'mgs')).toBeNull();
    expect(scoreCommand(row, 'studio')).not.toBeNull();
    // Nor across the seam between the two: `ioc` would need the newline.
    expect(scoreCommand(row, 'ioc')).toBeNull();
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
    item({ id: 'a1', section: 'actions', label: 'New chat' }),
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

  it('lists the tabs a query names above chats that only contain its letters', () => {
    const noisy = [
      item({ id: 'p', section: 'sessions', label: 'Postgres connection pooling notes' }),
      item({ id: 'm', section: 'sessions', label: 'Move the sidebar rows to flat tokens' }),
      item({ id: 'g', section: 'navigate', label: 'Settings · General' }),
      item({ id: 'c', section: 'navigate', label: 'Settings · MCP' }),
    ];
    const { flat, bestIndex } = rankCommands(noisy, 'sett');
    expect(flat.map((entry) => entry.id)).toEqual(['c', 'g']);
    // Shorter first within the tier, and the armed row is the first one on screen.
    expect(bestIndex).toBe(0);
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

/**
 * The cursor the render draws and the one Enter reads are the same function,
 * because the palette's list lags the input on purpose: `useDeferredValue`
 * leaves a committed render where the text is new and the ranking is not, and
 * a second clamping rule would be a second answer to "which row is armed".
 */
describe('activeCommandIndex', () => {
  const registry: CommandItem[] = [
    item({ id: 's1', section: 'sessions', label: 'Session one' }),
    item({ id: 'n1', section: 'navigate', label: 'Gallery' }),
  ];

  it('follows the ranking when the user has pinned nothing', () => {
    const ranked = rankCommands(registry, 'gallery');
    expect(activeCommandIndex(ranked, null)).toBe(ranked.bestIndex);
    expect(ranked.flat[activeCommandIndex(ranked, null)].id).toBe('n1');
  });

  it('honours a pinned row over the ranking', () => {
    const ranked = rankCommands(registry, '');
    expect(activeCommandIndex(ranked, 'n1')).toBe(1);
  });

  /**
   * The list changes under a held cursor without a keystroke: sources answer
   * late, and discovery finishing inserts runner rows above everything below
   * them. The pin is an id precisely so the cursor follows the command rather
   * than keeping an offset that now names a different one.
   */
  it('follows a pinned command when rows are inserted above it', () => {
    const ranked = rankCommands(registry, '');
    expect(activeCommandIndex(ranked, 'n1')).toBe(1);

    const loaded = rankCommands(
      [
        registry[0],
        item({ id: 'a1', section: 'actions', label: 'New chat with Codex' }),
        item({ id: 'a2', section: 'actions', label: 'New chat with Claude Code' }),
        registry[1],
      ],
      ''
    );
    expect(loaded.flat[activeCommandIndex(loaded, 'n1')].id).toBe('n1');
  });

  /**
   * The list shrinks as a query narrows, so a row pinned against the wider one
   * can outlive it. Releasing to the best match is what stops Enter spending a
   * render on nothing.
   */
  it('releases a pin the query has narrowed past', () => {
    const ranked = rankCommands(registry, 'gallery');
    expect(activeCommandIndex(ranked, 's1')).toBe(ranked.bestIndex);
  });

  it('reports no cursor when nothing matched', () => {
    expect(activeCommandIndex(rankCommands(registry, 'zzzqqq'), 's1')).toBe(-1);
  });
});
