/**
 * The copy rules of `docs/design/patterns.md`, held to both dictionaries so a
 * new string cannot quietly break them: one ellipsis character, one product
 * name, and the badge words sentence-cased (the CSS no longer upper-cases them).
 */

import { describe, expect, it } from 'bun:test';
import { en, ptBR } from '../../src/i18n';

type Tree = { readonly [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Array<[path: string, value: string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value] as [string, string]]
      : leaves(value, `${prefix}${key}.`)
  );
}

const dictionaries = { en, 'pt-BR': ptBR } as const;

describe.each(Object.entries(dictionaries))('%s copy rules', (_locale, messages) => {
  const entries = leaves(messages as Tree);

  it('writes the ellipsis as the single character, never three dots', () => {
    const offenders = entries.filter(([, value]) => value.includes('...')).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('spells the product MangoStudio, one word', () => {
    const offenders = entries
      .filter(([, value]) => /mango\s+studio/i.test(value))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('capitalises the file change badges, which render exactly as written', () => {
    const { opCreate, opOverwrite, opUpdate, opDelete, opMove } = messages.tools.diff;
    for (const badge of [opCreate, opOverwrite, opUpdate, opDelete, opMove]) {
      expect(badge.charAt(0)).toBe(badge.charAt(0).toUpperCase());
      expect(badge.slice(1)).toBe(badge.slice(1).toLowerCase());
    }
  });
});

describe('dictionary parity', () => {
  it('keeps en and pt-BR on exactly the same keys', () => {
    const enKeys = leaves(en as Tree).map(([path]) => path);
    const ptKeys = leaves(ptBR as Tree).map(([path]) => path);
    expect(enKeys).toEqual(ptKeys);
  });
});
