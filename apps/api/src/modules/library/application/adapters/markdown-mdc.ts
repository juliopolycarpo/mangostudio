import type { AdaptNote } from '@mangostudio/shared/library';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import { extractFrontmatterBody, removeFrontmatterSeparator } from './frontmatter-framing';
import type { FormatAdapter } from './types';

export const MDC_DESCRIPTION_MAX_LENGTH = 160;

export const markdownToMdcAdapter: FormatAdapter = {
  kind: 'instruction',
  from: 'markdown-plain',
  to: 'mdc',
  strategy: 'mechanical',
  lossy: false,
  adapt: ({ content }) => {
    const description = deriveDescription(content);
    return {
      ok: true,
      content: [
        '---',
        `description: ${JSON.stringify(description)}`,
        'alwaysApply: true',
        '---',
        '',
        content,
      ].join('\n'),
      notes: [
        {
          code: 'metadata-added',
          field: 'description',
          message: 'description was derived from the instruction body',
        },
        {
          code: 'metadata-added',
          field: 'alwaysApply',
          message: 'alwaysApply was set to true for the global instruction',
        },
      ],
      requiresReview: false,
      lossy: false,
    };
  },
};

export const mdcToMarkdownAdapter: FormatAdapter = {
  kind: 'instruction',
  from: 'mdc',
  to: 'markdown-plain',
  strategy: 'mechanical',
  lossy: true,
  adapt: ({ content }) => {
    const parsed = parseMarkdownFrontmatter(content);
    const body = extractFrontmatterBody(content);
    if (body === undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid-source',
          message: 'Cursor rule does not contain a complete opening frontmatter block.',
        },
      };
    }

    const notes: AdaptNote[] = Object.keys(parsed.frontmatter)
      .sort(compareText)
      .map((field) => ({
        code: 'field-dropped',
        field,
        message: `${field} has no representation in plain markdown and was dropped`,
      }));
    return {
      ok: true,
      content: removeFrontmatterSeparator(body),
      notes,
      requiresReview: false,
      lossy: notes.length > 0,
    };
  },
};

function deriveDescription(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const heading = normalized
    .split('\n')
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .find(Boolean);
  const prose = normalized
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .split(/(?<=[.!?])(?:\s+|$)/, 1)[0]
    ?.replace(/\s+/g, ' ')
    .trim();
  const candidate = heading || prose || 'Imported instruction';
  return truncate(candidate, MDC_DESCRIPTION_MAX_LENGTH);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
