/**
 * Minimal YAML-frontmatter parser for markdown documents delimited by `---`
 * lines. Supports the scalar, inline-array, and block-array subset used by
 * agent and skill markdown files — not general YAML.
 */

const FRONTMATTER_BOUNDARY = '---';
const ARRAY_ITEM_PREFIX = '- ';

export type MarkdownFrontmatterValue = string | number | boolean | ReadonlyArray<string>;
export type MarkdownFrontmatter = Record<string, MarkdownFrontmatterValue>;

export interface ParsedMarkdownDocument {
  readonly frontmatter: MarkdownFrontmatter;
  readonly body: string;
}

/**
 * Split a markdown document into frontmatter and body. Documents without a
 * complete `---` block yield an empty frontmatter and the unchanged input as
 * body. CRLF line endings are normalized before parsing.
 * // Usage: const { frontmatter, body } = parseMarkdownFrontmatter(markdown);
 */
export function parseMarkdownFrontmatter(markdown: string): ParsedMarkdownDocument {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_BOUNDARY) {
    return { frontmatter: {}, body: markdown };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_BOUNDARY
  );
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown };
  }

  return {
    frontmatter: parseFrontmatterLines(lines.slice(1, closingIndex)),
    body: lines.slice(closingIndex + 1).join('\n'),
  };
}

function parseFrontmatterLines(lines: ReadonlyArray<string>): MarkdownFrontmatter {
  const frontmatter: MarkdownFrontmatter = {};
  let arrayKey: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    if (arrayKey && trimmedLine.startsWith(ARRAY_ITEM_PREFIX)) {
      const currentValue = frontmatter[arrayKey];
      frontmatter[arrayKey] = [
        ...(isStringArray(currentValue) ? currentValue : []),
        unquote(trimmedLine.slice(ARRAY_ITEM_PREFIX.length).trim()),
      ];
      continue;
    }

    arrayKey = undefined;
    const separatorIndex = trimmedLine.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (!rawValue) {
      frontmatter[key] = [];
      arrayKey = key;
      continue;
    }

    frontmatter[key] = parseFrontmatterScalar(rawValue);
  }

  return frontmatter;
}

function parseFrontmatterScalar(rawValue: string): MarkdownFrontmatterValue {
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    return rawValue
      .slice(1, -1)
      .split(',')
      .map((value) => unquote(value.trim()))
      .filter(Boolean);
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  const numericValue = Number(rawValue);
  if (Number.isFinite(numericValue) && rawValue !== '') {
    return numericValue;
  }

  return unquote(rawValue);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
