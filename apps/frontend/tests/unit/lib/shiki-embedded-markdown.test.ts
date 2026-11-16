import { expect, it } from 'bun:test';

// Its own file so the highlighter starts with no grammar loaded: a sibling case
// that loaded python first would hide the dependency this one pins down.
const MARKDOWN_WITH_PYTHON = '# Title\n\n```python\nvalue = [1, 2]\n```\n';

it('colours a fence inside a markdown block only after that fence grammar is loaded', async () => {
  const shiki = await import('@/lib/shiki');
  const realNow = Date.now;
  try {
    // Cold deadlines are qualified elsewhere; keep the render from timing out here.
    Date.now = () => 0;

    await shiki.preloadCodeLanguages(['md'], 'one-dark-pro');
    const markdownOnly = shiki.highlightCode(MARKDOWN_WITH_PYTHON, 'md', 'one-dark-pro');
    await shiki.preloadCodeLanguages(['md', 'py'], 'one-dark-pro');
    const withPython = shiki.highlightCode(MARKDOWN_WITH_PYTHON, 'md', 'one-dark-pro');

    expect(markdownOnly, 'markdown rendered with only the markdown grammar').not.toBeNull();
    expect(withPython, 'markdown rendered once python was loaded too').not.toBeNull();
    expect(
      withPython,
      'expected the python fence to gain token colours when its grammar loads; received identical HTML'
    ).not.toBe(markdownOnly);
  } finally {
    Date.now = realNow;
  }
});
