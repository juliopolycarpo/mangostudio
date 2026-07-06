import { describe, expect, it } from 'bun:test';
import { parseMarkdownFrontmatter } from '../../src/markdown';

describe('parseMarkdownFrontmatter', () => {
  it('splits frontmatter and body', () => {
    const { frontmatter, body } = parseMarkdownFrontmatter(
      '---\nname: demo\ndescription: "A demo skill"\n---\n\n# Body\n'
    );
    expect(frontmatter).toEqual({ name: 'demo', description: 'A demo skill' });
    expect(body).toBe('\n# Body\n');
  });

  it('returns the whole document as body when frontmatter is missing', () => {
    const markdown = '# Just a doc\n';
    expect(parseMarkdownFrontmatter(markdown)).toEqual({ frontmatter: {}, body: markdown });
  });

  it('returns the whole document as body when the closing boundary is missing', () => {
    const markdown = '---\nname: demo\n\n# Body';
    expect(parseMarkdownFrontmatter(markdown)).toEqual({ frontmatter: {}, body: markdown });
  });

  it('normalizes CRLF line endings', () => {
    const { frontmatter, body } = parseMarkdownFrontmatter('---\r\nname: demo\r\n---\r\nBody\r\n');
    expect(frontmatter).toEqual({ name: 'demo' });
    expect(body).toBe('Body\n');
  });

  it('parses scalars, booleans, and numbers', () => {
    const { frontmatter } = parseMarkdownFrontmatter(
      "---\ntitle: 'quoted'\nflag: true\nother: false\ncount: 3\n---\nbody"
    );
    expect(frontmatter).toEqual({ title: 'quoted', flag: true, other: false, count: 3 });
  });

  it('parses inline and block arrays', () => {
    const { frontmatter } = parseMarkdownFrontmatter(
      '---\ninline: [a, "b", c]\nblock:\n  - one\n  - "two"\n---\nbody'
    );
    expect(frontmatter).toEqual({ inline: ['a', 'b', 'c'], block: ['one', 'two'] });
  });

  it('skips blank lines, comments, and keyless lines', () => {
    const { frontmatter } = parseMarkdownFrontmatter(
      '---\n# comment\n\nname: demo\nnot a mapping\n: empty-key\n---\nbody'
    );
    expect(frontmatter).toEqual({ name: 'demo' });
  });
});
