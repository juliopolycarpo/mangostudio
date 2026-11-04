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
  /** Retain the shell scanner's treatment of indented inline continuations. */
  readonly inlineContinuation?: boolean;
  /** The flat input reader historically inspects key lines only. */
  readonly inlineOnly?: boolean;
  readonly skip?: (match: RegExpExecArray, previousKey: string) => boolean;
}

/**
 * Claim scalar content before looking for another key. Indentation is measured
 * at the key's column, including a list marker, and source line numbers survive.
 * Callers own which keys count and how the resulting scalar is interpreted.
 */
export function scanWorkflowScalars(source: string, options: ScalarOptions): WorkflowScalar[] {
  const found: WorkflowScalar[] = [];
  let active: { indent: number; scalar: WorkflowScalar } | undefined;
  let previousKey = '';

  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const comment = trimmed.startsWith('#');
    if (comment && options.comments === 'ignore') return;

    if (active) {
      if (text.search(/\S/) > active.indent) {
        active.scalar.lines.push({ line: index + 1, text });
        return;
      }
      active = undefined;
    }

    const match = options.opener.exec(text);
    if (match?.groups) {
      const { indent, marker, key, value } = match.groups;
      const skip = options.skip?.(match, previousKey);
      previousKey = trimmed;
      if (skip) return;
      const block =
        value.trimStart().startsWith('|') ||
        value.trimStart().startsWith('>') ||
        (options.emptyIsBlock === true && value.trim() === '');
      const scalar: WorkflowScalar = {
        key,
        value,
        block,
        opener: { line: index + 1, text },
        lines: [],
      };
      found.push(scalar);
      if (!options.inlineOnly && (block || options.inlineContinuation)) {
        active = { indent: indent.length + (marker?.length ?? 0), scalar };
      }
      return;
    }
    if (!comment) previousKey = trimmed;
  });

  return found;
}
