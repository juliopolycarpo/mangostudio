import { describe, expect, it } from 'bun:test';

import {
  FirstPassStopsTokenizerClock,
  frozenTokenizerClock,
  withTokenizerClock,
} from '../../support/mocks/fake-tokenizer-clock';

/**
 * Vitest called `vi.resetModules()` between cases so each one got an
 * uninitialized highlighter. `bun test` has no equivalent, and one module
 * instance is enough: `--isolate` gives the file a fresh graph, and only the
 * first case depends on the highlighter not being built yet. It has to stay
 * first, and it fails loudly rather than silently if it does not.
 *
 * Kept behind a function returning the dynamic import, exactly as before: knip
 * traces member access on a namespace it can see and would then report
 * `initHighlighter` and `CODE_THEMES` as unused exports, failing `bun run
 * check`. Bun does honour a cache-busting query (`@/lib/shiki?fresh=1` really
 * is a second instance) but it hides the module from knip the same way.
 */
function loadShiki(): Promise<typeof import('@/lib/shiki')> {
  return import('@/lib/shiki');
}

function completeRender(render: () => string | null): string | null {
  const realNow = Date.now;
  try {
    // These cases test readiness and aliases; cold deadlines have a separate qualification matrix.
    Date.now = unchangedClock;
    return render();
  } finally {
    Date.now = realNow;
  }
}

function unchangedClock(): number {
  return 0;
}

describe('shiki highlighter', () => {
  it('does not highlight before the async highlighter is initialized', async () => {
    const shiki = await loadShiki();

    expect(shiki.highlightCode('const x = 1;', 'ts', 'one-dark-pro')).toBeNull();
  });

  it('starts with no theme and no grammar loaded', async () => {
    const shiki = await loadShiki();

    const highlighter = await shiki.initHighlighter();

    expect(highlighter.getLoadedThemes()).toEqual([]);
    expect(highlighter.getLoadedLanguages()).not.toContain('typescript');
  });

  it('loads the requested theme and language, and no other of either', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['ts'], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();

    expect(highlighter.getLoadedThemes()).toEqual(['one-dark-pro']);
    expect(highlighter.getLoadedLanguages()).toContain('typescript');
    for (const untouched of ['python', 'bash', 'markdown', 'rust', 'json']) {
      expect(
        highlighter.getLoadedLanguages(),
        `language ${untouched} was not requested`
      ).not.toContain(untouched);
    }
  });

  it('loads a second theme only when it is asked for', async () => {
    const shiki = await loadShiki();
    const highlighter = await shiki.initHighlighter();
    expect(highlighter.getLoadedThemes()).not.toContain('github-light');

    await shiki.preloadCodeLanguages(['ts'], 'github-light');

    expect(highlighter.getLoadedThemes()).toEqual(
      expect.arrayContaining(['one-dark-pro', 'github-light'])
    );
    const html = completeRender(() => shiki.highlightCode('const x = 1;', 'ts', 'github-light'));
    expect(html).toContain('shiki');
  });

  it('highlights common language aliases after preload', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['ts'], 'one-dark-pro');
    const html = completeRender(() => shiki.highlightCode('const x = 1;', 'ts', 'one-dark-pro'));

    expect(html).toContain('shiki');
    expect(html).toContain('const');
  });

  it('loads supported uncommon languages on demand', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['rust'], 'one-dark-pro');
    const html = completeRender(() => shiki.highlightCode('fn main() {}', 'rust', 'one-dark-pro'));

    expect(html).toContain('shiki');
    expect(html).toContain('main');
  });

  it('colours an rs fence with the rust grammar', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['rs'], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();
    const html = completeRender(() => shiki.highlightCode('fn main() {}', 'rs', 'one-dark-pro'));

    expect(highlighter.getLoadedLanguages()).toContain('rust');
    expect(html, 'rs fence html').toContain('<span style=');
  });

  it('colours a jsonc fence and scopes its comments as comments', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['jsonc'], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();
    const comment = shiki.highlightLineTokens('// strict mode', 'jsonc', 'one-dark-pro');
    const property = shiki.highlightLineTokens('{"a": 1}', 'jsonc', 'one-dark-pro');

    expect(highlighter.getLoadedLanguages()).toContain('json');
    // A comment the grammar does not know is coloured as invalid or plain text; a known one gets
    // the theme's comment colour, which differs from the property colour.
    const commentColor = comment?.find((token) => token.content.includes('strict'))?.color;
    const propertyColor = property?.find((token) => token.content.includes('a'))?.color;
    expect(commentColor, `jsonc comment token colour | expected: a theme colour`).toBeDefined();
    expect(commentColor, `jsonc comment ${commentColor} vs property ${propertyColor}`).not.toBe(
      propertyColor
    );
  });

  it('colours a diff fence with the diff grammar', async () => {
    const shiki = await loadShiki();

    await shiki.preloadCodeLanguages(['diff'], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();
    const html = completeRender(() =>
      shiki.highlightCode('@@ -1 +1 @@\n-old\n+new', 'diff', 'one-dark-pro')
    );

    expect(highlighter.getLoadedLanguages()).toContain('diff');
    expect(html, 'diff fence html').toContain('<span style=');
  });

  // The grammar scope names of every token on a line, so a test can tell a coloured token from
  // one the grammar did not recognise (those carry only the root scope, e.g. `source.vue`).
  function scopedTokens(
    highlighter: Awaited<ReturnType<Awaited<ReturnType<typeof loadShiki>>['initHighlighter']>>,
    code: string,
    lang: 'vue' | 'svelte'
  ): { content: string; scopes: string[] }[] {
    // `includeExplanation` tokenizes every line twice, each pass with its own `tokenizeTimeLimit`
    // check, and zips the results. A pass that stops early on a slow machine leaves the zip short
    // and shiki throws, so the clock is pinned for the whole call (the flake in #2646).
    const tokens = withTokenizerClock(frozenTokenizerClock, () =>
      highlighter.codeToTokensBase(code, {
        lang,
        theme: 'one-dark-pro',
        includeExplanation: 'scopeName',
      })
    );
    return tokens.flatMap((line) =>
      line.map((token) => ({
        content: token.content,
        scopes: (token.explanation ?? []).flatMap((part) =>
          part.scopes.map((scope) => scope.scopeName)
        ),
      }))
    );
  }

  const embeddedFences = [
    {
      lang: 'vue',
      code: [
        '<script setup lang="ts">',
        'const count: number = 1;',
        '</script>',
        '<template><p class="a">{{ count }}</p></template>',
        '<style scoped>',
        '.a { color: red; }',
        '</style>',
      ].join('\n'),
    },
    {
      lang: 'svelte',
      code: [
        '<script lang="ts">',
        '  let count: number = 1;',
        '</script>',
        '<p class="a">{count}</p>',
        '<style>',
        '  .a { color: red; }',
        '</style>',
      ].join('\n'),
    },
  ] as const;

  for (const { lang, code } of embeddedFences) {
    it(`colours a ${lang} fence, including its embedded script and style`, async () => {
      const shiki = await loadShiki();

      await shiki.preloadCodeLanguages([lang], 'one-dark-pro');
      const highlighter = await shiki.initHighlighter();
      const tokens = scopedTokens(highlighter, code, lang);
      const scopeNames = new Set(tokens.flatMap((token) => token.scopes));

      expect(highlighter.getLoadedLanguages(), `${lang} grammar`).toContain(lang);
      // The host grammar alone leaves `<script>` and `<style>` bodies plain; these scopes only
      // appear when the embedded grammars (typescript, css) were registered with it.
      expect(
        [...scopeNames].some((scope) => scope.startsWith('source.ts')),
        `${lang}: expected a source.ts scope from the embedded script | scopes: ${[...scopeNames].join(', ')}`
      ).toBe(true);
      expect(
        [...scopeNames].some((scope) => scope.startsWith('source.css')),
        `${lang}: expected a source.css scope from the embedded style | scopes: ${[...scopeNames].join(', ')}`
      ).toBe(true);
      const html = completeRender(() => shiki.highlightCode(code, lang, 'one-dark-pro'));
      expect(html, `${lang} fence html`).toContain('<span style=');
    });
  }

  it('explains scopes even when the clock passes the limit during only the first pass', async () => {
    const shiki = await loadShiki();
    const { lang, code } = embeddedFences[0];

    await shiki.preloadCodeLanguages([lang], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();
    const tokens = withTokenizerClock(new FirstPassStopsTokenizerClock().now, () =>
      scopedTokens(highlighter, code, lang)
    );

    expect(
      tokens.length,
      `${lang} tokens | expected: a non-empty explained token list`
    ).toBeGreaterThan(0);
  });

  it('documents that shiki itself throws when only the first explanation pass stops', async () => {
    const shiki = await loadShiki();
    const { lang, code } = embeddedFences[0];

    await shiki.preloadCodeLanguages([lang], 'one-dark-pro');
    const highlighter = await shiki.initHighlighter();

    // Upstream hazard the helper above guards against; if shiki fixes the zip this test fails and
    // the guard can go.
    expect(() =>
      withTokenizerClock(new FirstPassStopsTokenizerClock().now, () =>
        highlighter.codeToTokensBase(code, {
          lang,
          theme: 'one-dark-pro',
          includeExplanation: 'scopeName',
        })
      )
    ).toThrow(TypeError);
  });

  it('ignores unsupported languages without initializing the highlighter', async () => {
    const shiki = await loadShiki();

    await expect(shiki.preloadCodeLanguages(['not-a-real-language'], 'one-dark-pro')).resolves.toBe(
      false
    );
    expect(shiki.highlightCode('x', 'not-a-real-language', 'one-dark-pro')).toBeNull();
  });
});
