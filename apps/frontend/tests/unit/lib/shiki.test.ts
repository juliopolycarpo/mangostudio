import { describe, expect, it, vi } from 'vitest';

function loadFreshShiki() {
  vi.resetModules();
  return import('@/lib/shiki');
}

describe('shiki highlighter', () => {
  it('does not highlight before the async highlighter is initialized', async () => {
    const shiki = await loadFreshShiki();

    expect(shiki.highlightCode('const x = 1;', 'ts', 'one-dark-pro')).toBeNull();
  });

  it('highlights common language aliases after preload', async () => {
    const shiki = await loadFreshShiki();

    await shiki.preloadCodeLanguages(['ts']);
    const html = shiki.highlightCode('const x = 1;', 'ts', 'one-dark-pro');

    expect(html).toContain('shiki');
    expect(html).toContain('const');
  });

  it('loads supported uncommon languages on demand', async () => {
    const shiki = await loadFreshShiki();

    await shiki.preloadCodeLanguages(['rust']);
    const html = shiki.highlightCode('fn main() {}', 'rust', 'one-dark-pro');

    expect(html).toContain('shiki');
    expect(html).toContain('main');
  });

  it('ignores unsupported languages without initializing the highlighter', async () => {
    const shiki = await loadFreshShiki();

    await expect(shiki.preloadCodeLanguages(['not-a-real-language'])).resolves.toBe(false);
    expect(shiki.highlightCode('x', 'not-a-real-language', 'one-dark-pro')).toBeNull();
  });
});
