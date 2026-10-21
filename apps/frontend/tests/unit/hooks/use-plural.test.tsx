/**
 * One/other agreement for counted messages.
 *
 * The dictionaries keep a `xOne` / `xOther` pair per counted message instead of
 * a `(s)` suffix, and this is the one rule that picks between them. Both shipped
 * locales are covered because Portuguese needs more than a trailing "s": the
 * adjective and the participle agree too.
 */

import { describe, expect, it } from 'bun:test';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { pluralMessage, usePlural } from '@/hooks/use-plural';
import { renderHook } from '../../support/harness/render';

const FILES = { one: '{count} file changed', other: '{count} files changed' } as const;
const ARQUIVOS = { one: '{count} arquivo alterado', other: '{count} arquivos alterados' } as const;

describe('pluralMessage', () => {
  it('uses the singular form for exactly one, and the plural otherwise, in English', () => {
    expect(pluralMessage(FILES, 1, 'en')).toBe('1 file changed');
    expect(pluralMessage(FILES, 2, 'en')).toBe('2 files changed');
    expect(pluralMessage(FILES, 0, 'en')).toBe('0 files changed');
    expect(pluralMessage(FILES, 21, 'en')).toBe('21 files changed');
  });

  it('agrees both the noun and the adjective in Portuguese', () => {
    expect(pluralMessage(ARQUIVOS, 1, 'pt-BR')).toBe('1 arquivo alterado');
    expect(pluralMessage(ARQUIVOS, 3, 'pt-BR')).toBe('3 arquivos alterados');
  });

  it('reads a million as plural in Portuguese, where CLDR calls it "many"', () => {
    expect(pluralMessage(ARQUIVOS, 1_000_000, 'pt-BR')).toBe('1000000 arquivos alterados');
  });

  it('lets a caller supply its own figure, so grouped digits survive', () => {
    expect(pluralMessage(FILES, 10_826, 'en', { count: '10,826' })).toBe('10,826 files changed');
  });

  it('leaves a placeholder it was not given untouched', () => {
    expect(pluralMessage({ one: '{count} of {total}', other: '{count} of {total}' }, 2, 'en')).toBe(
      '2 of {total}'
    );
  });
});

describe('usePlural', () => {
  it('binds the active locale', () => {
    const { result } = renderHook(() => usePlural());
    expect(result.current(FILES, 1)).toBe('1 file changed');
    expect(result.current(FILES, 5)).toBe('5 files changed');
  });
});

describe('the dictionaries', () => {
  /** The counted messages that moved from a `(s)` suffix to a One/Other pair. */
  const PAIRS = [
    'chat.fileCheckpoints.reverted',
    'chat.fileCheckpoints.revertedWithShell',
    'chat.fileCheckpoints.revertedWithMcp',
    'chat.fileCheckpoints.revertedWithBoth',
    'home.workspaces.dirty',
    'home.workspaces.sessions',
    'home.workspaces.more',
    'home.machines.navAlerts',
    'home.workspace.dirtyTree',
    'home.skills.labelDivergent',
    'home.skills.more',
    'home.skills.singleTarget',
    'home.library.labelDivergent',
    'home.library.more',
    'home.library.singleTarget',
    'home.uncommitted.changed',
    'home.uncommitted.unpushed',
    'home.uncommitted.more',
    'home.activity.newCount',
    'settings.connectors.chatgptRedeemConfirmRestores',
    'settings.connectors.chatgptRedeemSuccess',
    'sidebar.git.dirty',
  ] as const;

  function lookup(dictionary: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
        dictionary
      );
  }

  for (const [name, dictionary] of [
    ['en', en],
    ['pt-BR', ptBR],
  ] as const) {
    it(`gives every counted message a One and an Other that both take the count (${name})`, () => {
      const broken = PAIRS.flatMap((base) =>
        (['One', 'Other'] as const)
          .map((form) => [`${base}${form}`, lookup(dictionary, `${base}${form}`)] as const)
          .filter(([, value]) => typeof value !== 'string' || !value.includes('{count}'))
          .map(([key]) => key)
      );
      expect(broken).toEqual([]);
    });
  }

  function flatten(node: unknown, path: string, into: Map<string, string>): void {
    if (typeof node === 'string') {
      into.set(path, node);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) flatten(value, `${path}.${key}`, into);
    }
  }

  for (const [name, dictionary] of [
    ['en', en],
    ['pt-BR', ptBR],
  ] as const) {
    it(`has no "(s)" plural hack left in a counted message (${name})`, () => {
      const flat = new Map<string, string>();
      flatten(dictionary, name, flat);
      const hacks = [...flat.entries()]
        .filter(([, value]) => value.includes('{count}') && /\w\((s|es|ões|ns)\)/.test(value))
        .map(([key]) => key);
      expect(hacks).toEqual([]);
    });
  }
});
