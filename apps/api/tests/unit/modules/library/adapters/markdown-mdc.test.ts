import { describe, expect, it } from 'bun:test';
import {
  MDC_DESCRIPTION_MAX_LENGTH,
  markdownToMdcAdapter,
  mdcToMarkdownAdapter,
} from '../../../../../src/modules/library/application/adapters/markdown-mdc';

const input = (content: string, from: 'markdown-plain' | 'mdc', to: 'markdown-plain' | 'mdc') => ({
  content,
  kind: 'instruction' as const,
  from,
  to,
  resourceKey: 'instruction:global',
});

describe('Markdown and MDC adapters', () => {
  it('round-trips the body exactly, including a code fence containing a delimiter', async () => {
    const markdown = '# Repository rules\n\n```md\n---\nnot: frontmatter\n```\n';
    const wrapped = await markdownToMdcAdapter.adapt(input(markdown, 'markdown-plain', 'mdc'));
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    const unwrapped = await mdcToMarkdownAdapter.adapt(
      input(wrapped.content, 'mdc', 'markdown-plain')
    );
    expect(unwrapped).toMatchObject({ ok: true, content: markdown });
  });

  it('preserves CRLF body bytes through a round trip', async () => {
    const markdown = '\uFEFF# Repository rules\r\n\r\nKeep this ending.\r\n';
    const wrapped = await markdownToMdcAdapter.adapt(input(markdown, 'markdown-plain', 'mdc'));
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.content).toContain('description: "Repository rules"');

    const unwrapped = await mdcToMarkdownAdapter.adapt(
      input(wrapped.content, 'mdc', 'markdown-plain')
    );
    expect(unwrapped).toMatchObject({ ok: true, content: markdown });
  });

  it('synthesizes one-line bounded metadata and reports both added fields', async () => {
    const heading = `# ${'A'.repeat(MDC_DESCRIPTION_MAX_LENGTH + 20)}\n\nBody.`;
    const result = await markdownToMdcAdapter.adapt(input(heading, 'markdown-plain', 'mdc'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const descriptionLine = result.content.split('\n')[1] ?? '';
    const description = JSON.parse(descriptionLine.slice('description: '.length));
    expect(description).not.toContain('\n');
    expect(description).toHaveLength(MDC_DESCRIPTION_MAX_LENGTH);
    expect(description.endsWith('…')).toBe(true);
    expect(result.notes.map((note) => note.field)).toEqual(['description', 'alwaysApply']);
  });

  it('reports every dropped frontmatter field exactly once', async () => {
    const result = await mdcToMarkdownAdapter.adapt(
      input(
        '---\ndescription: "Rule"\nglobs: "*.ts"\nalwaysApply: false\n---\n\n# Body\n',
        'mdc',
        'markdown-plain'
      )
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toBe('# Body\n');
    expect(result.notes.map((note) => note.field)).toEqual(['alwaysApply', 'description', 'globs']);
    expect(new Set(result.notes.map((note) => note.field)).size).toBe(result.notes.length);
  });

  it('rejects plain Markdown presented as an MDC source', async () => {
    const result = await mdcToMarkdownAdapter.adapt(
      input('# No frontmatter\n', 'mdc', 'markdown-plain')
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-source' } });
  });
});
