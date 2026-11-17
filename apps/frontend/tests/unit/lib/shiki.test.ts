import { describe, expect, it } from 'bun:test';

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

  it('ignores unsupported languages without initializing the highlighter', async () => {
    const shiki = await loadShiki();

    await expect(shiki.preloadCodeLanguages(['not-a-real-language'], 'one-dark-pro')).resolves.toBe(
      false
    );
    expect(shiki.highlightCode('x', 'not-a-real-language', 'one-dark-pro')).toBeNull();
  });
});
