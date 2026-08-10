/**
 * Turning an ACP tool call into something to render.
 *
 * Observational, like every activity in this cycle: a pill with a label, a
 * title and some detail. Nothing here enters MangoStudio's tool registry,
 * executor, permission engine, workdir policy or budget accounting, and nothing
 * in it names a MangoStudio tool.
 *
 * One asymmetry with Codex is worth naming, because it decides what the pill
 * says. Codex's items carry the vendor's own tool name (`commandExecution`,
 * an MCP tool's name) and a kind can be derived from it. **ACP has no tool-name
 * field at all** — a `tool_call` on the live build is
 * `{ toolCallId, title, kind, status, rawInput }`, where `title` is prose
 * ("`echo hello-from-acp`") and `kind` is one of ten protocol categories. So the
 * kind doubles as the name, verbatim and untranslated, and the prose becomes the
 * title. Inventing a nicer name would be MangoStudio narrating the vendor's
 * work.
 */

import type { ExternalActivityKind } from '@mangostudio/shared/external-agents';
import type { AcpToolCallContent, AcpToolCallFields, AcpToolKind } from './protocol';

/** How much of a tool call's own output one rendered field carries. */
export const CURSOR_DETAIL_MAX_CHARS = 2_000;

/**
 * ACP's ten tool kinds, mapped onto the neutral icon buckets.
 *
 * `read` and `search` land on `other` rather than `file-change`: both look, and
 * a file-change icon on a read is a claim about the workspace that did not
 * happen. `fetch` is the network one, which is what `web-search` buckets.
 * `switch_mode` and `think` have no icon of their own and are not worth
 * inventing one for.
 */
export function activityKindFor(kind: AcpToolKind | undefined): ExternalActivityKind {
  switch (kind) {
    case 'execute':
      return 'command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file-change';
    case 'fetch':
      return 'web-search';
    default:
      return 'other';
  }
}

/**
 * The pill label: Cursor's own kind, verbatim.
 *
 * Falls back to `other`, which is ACP's own name for an uncategorized call, so
 * the label is always a word from the protocol rather than one MangoStudio made
 * up.
 */
export function activityNameFor(kind: AcpToolKind | undefined): string {
  return typeof kind === 'string' && kind.length > 0 ? kind : 'other';
}

/** The prose title, or the kind again when the vendor sent none. */
export function toolCallTitle(call: AcpToolCallFields | undefined): string {
  const title = call?.title;
  if (typeof title === 'string' && title.length > 0) return title;
  return activityNameFor(call?.kind);
}

/**
 * Whether a status means the call is over, and how it ended.
 *
 * `pending` and `in_progress` are not terminal, and `undefined` is not either —
 * a `tool_call_update` that carries only new content is a progress report, not
 * a completion, and treating it as one would close a pill the vendor is still
 * writing to.
 */
export function toolCallOutcome(status: string | undefined): 'completed' | 'failed' | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return undefined;
}

function textOf(block: AcpToolCallContent): string | undefined {
  if (!block || typeof block !== 'object') return undefined;
  if (block.type === 'content') {
    const text = (block as { readonly content?: { readonly text?: unknown } }).content?.text;
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  }
  if (block.type === 'diff') {
    const path = (block as { readonly path?: unknown }).path;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  }
  return undefined;
}

/**
 * The rendered detail for one tool call.
 *
 * ACP's `content` blocks are the vendor's own display channel and are preferred.
 * `rawInput` / `rawOutput` are the fallback and are rendered as bounded JSON
 * rather than guessed at: Cursor puts `{ command }` on a shell call's input and
 * `{ exitCode, stdout, stderr }` on its output, but those keys are Cursor's, not
 * ACP's, and a reader that special-cased `stdout` would show nothing at all for
 * every other tool. Showing what the vendor actually returned is the honest
 * option, and it is the same class of data the content blocks carry.
 */
export function toolCallDetail(
  content: readonly AcpToolCallContent[] | undefined,
  raw: unknown
): string | undefined {
  const fromContent = (content ?? [])
    .map(textOf)
    .filter((text): text is string => text !== undefined)
    .join('\n');
  if (fromContent.length > 0) return truncate(fromContent);

  if (raw === undefined || raw === null) return undefined;
  let encoded: string;
  try {
    encoded = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    // A vendor payload with a cycle in it is not worth failing a turn over.
    return undefined;
  }
  return encoded && encoded !== '{}' ? truncate(encoded) : undefined;
}

/**
 * Cut to a code-point count, never to UTF-16 units.
 *
 * `slice` can land between the halves of a surrogate pair, and the resulting
 * lone surrogate is not encodable as UTF-8. Normalization strips it downstream,
 * but it strips it by *removing a character the user typed*, and marks the
 * whole field truncated for a reason that never existed.
 */
function truncate(value: string): string {
  const points = [...value];
  return points.length <= CURSOR_DETAIL_MAX_CHARS
    ? value
    : points.slice(0, CURSOR_DETAIL_MAX_CHARS).join('');
}
