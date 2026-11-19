import { describe, expect, it } from 'bun:test';

import { resolveLanguageId, SHIKI_LANGUAGE_IDS, type ShikiLanguageId } from '@/lib/code-languages';

describe('resolveLanguageId', () => {
  const cases: readonly [string, ShikiLanguageId | null][] = [
    ['typescript', 'typescript'],
    ['ts', 'typescript'],
    ['TS', 'typescript'],
    ['  py  ', 'python'],
    ['ts title="a.ts"', 'typescript'],
    ['c++', 'cpp'],
    ['zsh', 'bash'],
    ['md', 'markdown'],
    ['', null],
    ['   ', null],
    ['vue', 'vue'],
    ['VUE', 'vue'],
    ['rs', 'rust'],
    ['RS', 'rust'],
    ['jsonc', 'json'],
    ['jsonc title="tsconfig.json"', 'json'],
    ['diff', 'diff'],
    ['svelte', 'svelte'],
    ['svelte title="+page.svelte"', 'svelte'],
    ['constructor', null],
    ['__proto__', null],
  ];
  for (const [info, expected] of cases) {
    it(`maps ${JSON.stringify(info)} to ${JSON.stringify(expected)}`, () => {
      expect(resolveLanguageId(info), `info string: ${JSON.stringify(info)}`).toBe(expected);
    });
  }

  it('resolves every supported id to itself', () => {
    for (const id of SHIKI_LANGUAGE_IDS) {
      expect(resolveLanguageId(id), `language id: ${id}`).toBe(id);
    }
  });
});
