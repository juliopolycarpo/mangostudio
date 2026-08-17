import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import type { Messages } from '@mangostudio/shared/i18n';
import { formatMessage } from '@/lib/i18n-format';

type FileCheckpointLabels = Messages['chat']['fileCheckpoints'];

/**
 * Which combination of uncovered write classes a turn has, as the suffix the
 * label keys of both surfaces are named on.
 *
 * One complete sentence per combination rather than a generic warning with the
 * sources spliced in: a user who only ran MCP tools must not be told about
 * shell commands, and the two are hedged differently — a shell command's writes
 * are certain to be uncovered, while an MCP tool may not have written at all.
 * Assembling that from fragments would also force every locale through English
 * list grammar.
 *
 * `null` when the manifest covered the turn. At a third source this stops
 * scaling and the move is per-source fragments plus a locale-provided joiner,
 * not more combination keys.
 */
type SourceVariant = 'Shell' | 'Mcp' | 'Both';

function variantOf(sources: ReadonlyArray<UncheckpointedWriteSource>): SourceVariant | null {
  const shell = sources.includes('shell');
  const mcp = sources.includes('mcp');
  if (shell && mcp) return 'Both';
  if (shell) return 'Shell';
  if (mcp) return 'Mcp';
  return null;
}

/**
 * Copy for the classes of write a revert does not cover, or `null` for a turn
 * the manifest covered — a notice that shows up every time is one users learn
 * to skip past.
 */
export function uncheckpointedWarning(
  sources: ReadonlyArray<UncheckpointedWriteSource>,
  labels: FileCheckpointLabels
): string | null {
  const variant = variantOf(sources);
  return variant ? labels[`uncheckpointed${variant}`] : null;
}

/** The post-revert result, restated rather than reported as a bare count. */
export function revertedMessage(
  revertedFiles: number,
  sources: ReadonlyArray<UncheckpointedWriteSource>,
  labels: FileCheckpointLabels
): string {
  const variant = variantOf(sources);
  const template = variant ? labels[`revertedWith${variant}`] : labels.reverted;
  return formatMessage(template, { count: String(revertedFiles) });
}
