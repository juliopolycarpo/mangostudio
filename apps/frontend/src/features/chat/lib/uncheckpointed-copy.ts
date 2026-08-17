import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import type { Messages } from '@mangostudio/shared/i18n';

type FileCheckpointLabels = Messages['chat']['fileCheckpoints'];

/**
 * Copy for the classes of write a revert does not cover.
 *
 * One complete sentence per combination rather than a generic warning with the
 * sources spliced in: a user who only ran MCP tools must not be told about
 * shell commands, and the two are hedged differently — a shell command's writes
 * are certain to be uncovered, while an MCP tool may not have written at all.
 * Assembling that from fragments would also force every locale through English
 * list grammar.
 */
export function uncheckpointedWarning(
  sources: ReadonlyArray<UncheckpointedWriteSource>,
  labels: FileCheckpointLabels
): string | null {
  const shell = sources.includes('shell');
  const mcp = sources.includes('mcp');
  if (shell && mcp) return labels.uncheckpointedBoth;
  if (shell) return labels.uncheckpointedShell;
  if (mcp) return labels.uncheckpointedMcp;
  // No warning at all when the manifest covered the turn: a notice that shows
  // up every time is one users learn to skip past.
  return null;
}

/** The post-revert result, restated rather than reported as a bare count. */
export function revertedMessage(
  revertedFiles: number,
  sources: ReadonlyArray<UncheckpointedWriteSource>,
  labels: FileCheckpointLabels
): string {
  const shell = sources.includes('shell');
  const mcp = sources.includes('mcp');
  const template =
    shell && mcp
      ? labels.revertedWithBoth
      : shell
        ? labels.revertedWithShell
        : mcp
          ? labels.revertedWithMcp
          : labels.reverted;
  return template.replace('{count}', String(revertedFiles));
}
