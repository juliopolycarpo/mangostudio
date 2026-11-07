/** Source-preserving scalar traversal for line-oriented workflow assertions.
 * `githubScripts` deliberately uses Bun.YAML instead: decoding quoted keys,
 * flow mappings and folded JavaScript remains part of its security policy.
 */
interface ScalarLine {
  readonly line: number;
  readonly text: string;
}

interface WorkflowScalar {
  readonly key: string;
  readonly value: string;
  readonly block: boolean;
  readonly opener: ScalarLine;
  readonly lines: ScalarLine[];
}

interface ScalarOptions {
  /** Named groups: indent, optional list marker, key, and value. */
  readonly opener: RegExp;
  /** Paths ignore YAML comments; shell scripts retain comment source lines. */
  readonly comments: 'ignore' | 'content';
  readonly emptyIsBlock?: boolean;
  readonly trimStyle?: boolean;
  /** Retain the shell scanner's treatment of indented inline continuations. */
  readonly inlineContinuation?: boolean;
  /** Scripts consume their body, paths revisit it, and flat inputs read key lines only. */
  readonly content: 'consume' | 'revisit' | 'none';
  readonly skipAfter?: string;
}

/**
 * Collect scalar content below the key's column, including a list marker.
 * Callers decide whether to revisit those lines as potential keys.
 *
 * @example
 * scanWorkflowScalars('  path: |\n    file.txt', {
 *   opener: /^(?<indent> *)(?<key>path): *(?<value>.*)$/,
 *   comments: 'ignore',
 *   content: 'revisit',
 * });
 */
export function scanWorkflowScalars(source: string, options: ScalarOptions): WorkflowScalar[] {
  const found: WorkflowScalar[] = [];
  const lines = source.split('\n');
  let previousKey = '';
  const ignored = (trimmed: string) =>
    trimmed === '' || (options.comments === 'ignore' && trimmed.startsWith('#'));

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const trimmed = text.trim();
    if (ignored(trimmed)) continue;
    const match = options.opener.exec(text);
    if (!match?.groups) {
      if (!trimmed.startsWith('#')) previousKey = trimmed;
      continue;
    }
    const { indent, marker, key, value } = match.groups;
    const skip = previousKey === options.skipAfter;
    previousKey = trimmed;
    if (skip) continue;

    const styleValue = options.trimStyle ? value.trimStart() : value;
    const block = /^[|>]/.test(styleValue) || (options.emptyIsBlock === true && styleValue === '');
    const scalar: WorkflowScalar = {
      key,
      value,
      block,
      opener: { line: index + 1, text },
      lines: [],
    };
    found.push(scalar);
    if (options.content === 'none' || (!block && !options.inlineContinuation)) continue;

    const keyColumn = indent.length + (marker?.length ?? 0);
    let next = index + 1;
    for (; next < lines.length; next += 1) {
      const body = lines[next];
      if (ignored(body.trim())) continue;
      if (body.search(/\S/) <= keyColumn) break;
      scalar.lines.push({ line: next + 1, text: body });
    }
    if (options.content === 'consume') index = next - 1;
  }
  return found;
}
