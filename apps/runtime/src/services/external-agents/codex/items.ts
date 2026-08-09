/**
 * Classifying Codex's `ThreadItem` union into the neutral event vocabulary.
 *
 * Three dispositions, and the distinction between them is the whole point:
 *
 * - **text** and **reasoning** are the agent talking. They stream as
 *   `text_delta` / `reasoning_delta`, and reasoning arrives on its own item with
 *   its own notifications rather than interleaved into the message deltas.
 * - **drop** is an echo. `userMessage` is the input MangoStudio just sent and
 *   `hookPrompt` is Codex replaying its own configuration; persisting either
 *   would duplicate the user's message in the transcript.
 * - **activity** is everything Codex *did*. It is observational — a pill with a
 *   label — and it never enters MangoStudio's tool registry, executor,
 *   permission engine or budget accounting. `dynamicToolCall` is in this group
 *   deliberately: seeing that Codex asked MangoStudio to run a tool is useful,
 *   and the request itself was already refused in `approvals.ts`.
 *
 * The switch is exhaustive over the union the vendor generated, so adding a
 * 19th item type is a compile error here rather than a silent gap. At runtime
 * an unrecognized `type` still resolves to `other` instead of throwing: a
 * runtime built against 0.147.0 will meet a newer Codex, and an additive item
 * type is not a reason to fail a turn.
 */

import type { ExternalActivityKind } from '@mangostudio/shared/external-agents';
import type { FileUpdateChange } from './protocol/v2/FileUpdateChange';
import type { PatchChangeKind } from './protocol/v2/PatchChangeKind';
import type { ThreadItem } from './protocol/v2/ThreadItem';

interface CodexItemActivity {
  readonly disposition: 'activity';
  readonly kind: ExternalActivityKind;
  /** The vendor's own tool name when it has one, else the item type. Rendered verbatim. */
  readonly name: string;
  readonly title: string;
  readonly detail?: string;
}

export type CodexItemClassification =
  | CodexItemActivity
  | { readonly disposition: 'text'; readonly text: string }
  | { readonly disposition: 'reasoning'; readonly text: string }
  | { readonly disposition: 'drop' };

/** Whether a completed item's own status says it succeeded. */
export function codexItemStatus(item: ThreadItem): 'completed' | 'failed' | 'cancelled' {
  const status = (item as { status?: unknown }).status;
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'cancelled';
  return 'completed';
}

function fileChangeTitle(changes: ReadonlyArray<{ path: string }>): string {
  if (changes.length === 0) return 'No files changed';
  if (changes.length === 1) return changes[0]?.path ?? '';
  return `${changes.length} files`;
}

/**
 * One line per change, from the **tagged** kind rather than the object itself.
 *
 * `PatchChangeKind` is `{type:'add'} | {type:'delete'} | {type:'update', move_path}`,
 * so interpolating it directly renders `[object Object] /path` — and this string
 * is persisted as the change summary a user reads. A rename carries its
 * destination in `move_path`, which is the whole content of that change.
 */
export function fileChangeDetail(changes: ReadonlyArray<FileUpdateChange>): string {
  return changes.map(fileChangeLine).join('\n');
}

function fileChangeLine(change: FileUpdateChange): string {
  const kind: PatchChangeKind = change.kind;
  if (kind.type === 'update' && kind.move_path) {
    return `rename ${change.path} → ${kind.move_path}`;
  }
  return `${kind.type} ${change.path}`;
}

export function classifyCodexItem(item: ThreadItem): CodexItemClassification {
  switch (item.type) {
    case 'agentMessage':
      return { disposition: 'text', text: item.text };
    case 'reasoning':
      // `summary` is the user-facing distillation; `content` is the raw chain.
      // Only the summary is surfaced, matching what Codex's own clients show.
      return { disposition: 'reasoning', text: item.summary.join('') };
    case 'userMessage':
    case 'hookPrompt':
      return { disposition: 'drop' };
    case 'commandExecution':
      return {
        disposition: 'activity',
        kind: 'command',
        name: 'commandExecution',
        title: item.command,
        ...(item.aggregatedOutput ? { detail: item.aggregatedOutput } : {}),
      };
    case 'fileChange':
      return {
        disposition: 'activity',
        kind: 'file-change',
        name: 'fileChange',
        title: fileChangeTitle(item.changes),
        detail: fileChangeDetail(item.changes),
      };
    case 'mcpToolCall':
      return {
        disposition: 'activity',
        kind: 'mcp',
        name: item.tool,
        title: `${item.server}/${item.tool}`,
      };
    case 'dynamicToolCall':
      // Inert by construction. The matching `item/tool/call` request was
      // refused; this exists so the refusal is visible rather than invisible.
      return {
        disposition: 'activity',
        kind: 'other',
        name: item.tool,
        title: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
      };
    case 'collabAgentToolCall':
      return {
        disposition: 'activity',
        kind: 'subagent',
        name: item.tool,
        title: item.tool,
        ...(item.prompt ? { detail: item.prompt } : {}),
      };
    case 'subAgentActivity':
      return {
        disposition: 'activity',
        kind: 'subagent',
        name: 'subAgentActivity',
        title: `${item.kind} ${item.agentPath}`,
      };
    case 'webSearch':
      return {
        disposition: 'activity',
        kind: 'web-search',
        name: 'webSearch',
        title: item.query,
      };
    case 'imageView':
      return {
        disposition: 'activity',
        kind: 'image',
        name: 'imageView',
        title: item.path,
      };
    case 'imageGeneration':
      return {
        disposition: 'activity',
        kind: 'image',
        name: 'imageGeneration',
        title: item.revisedPrompt ?? 'Generated image',
      };
    case 'plan':
      return { disposition: 'activity', kind: 'plan', name: 'plan', title: item.text };
    case 'enteredReviewMode':
      return {
        disposition: 'activity',
        kind: 'review',
        name: 'enteredReviewMode',
        title: item.review,
      };
    case 'exitedReviewMode':
      return {
        disposition: 'activity',
        kind: 'review',
        name: 'exitedReviewMode',
        title: item.review,
      };
    case 'contextCompaction':
      return {
        disposition: 'activity',
        kind: 'compaction',
        name: 'contextCompaction',
        title: 'Context compacted',
      };
    case 'sleep':
      return {
        disposition: 'activity',
        kind: 'other',
        name: 'sleep',
        title: `Waited ${item.durationMs}ms`,
      };
    default:
      return unknownItemActivity(item);
  }
}

/**
 * The additive-item escape hatch.
 *
 * Typed as `never` so that adding a case to the vendor's union without adding
 * one above fails the build, while still producing a sane value if a *newer*
 * Codex sends a type this build has never seen.
 */
function unknownItemActivity(item: never): CodexItemActivity {
  const type = (item as { type?: unknown }).type;
  const name = typeof type === 'string' && type.length > 0 ? type : 'unknown';
  return { disposition: 'activity', kind: 'other', name, title: name };
}

/** The item id, which is what every delta and completion correlates by. */
export function codexItemId(item: ThreadItem): string {
  return (item as { id?: unknown }).id as string;
}
