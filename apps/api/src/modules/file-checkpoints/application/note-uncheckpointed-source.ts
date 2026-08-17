import type { UncheckpointedWriteSource } from '@mangostudio/shared/file-checkpoints';
import type { Kysely } from 'kysely';
import { getDb } from '../../../db/database';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { recordUncheckpointedSource } from '../infrastructure/uncheckpointed-source-repository';

const logger = createDiagnosticLogger('file-checkpoints');

export interface UncheckpointedSourceContext {
  readonly chatId: string;
  /** Absent outside a turn, where there is no manifest for this to qualify. */
  readonly assistantMessageId?: string;
  readonly db?: Kysely<Database>;
}

/**
 * Records that the turn ran a tool whose writes the manifest cannot describe,
 * so revert can name what it did not undo.
 *
 * Called before the tool runs, not after: a shell command that times out or
 * fails has already had its chance to write, and a source recorded only on
 * success would leave exactly those turns claiming a complete revert.
 *
 * Bookkeeping, so it never fails the call it describes. Losing the note costs
 * a warning the user would have seen; refusing the tool over a failed insert
 * costs them the work.
 *
 * // Usage: await noteUncheckpointedSource(context, 'shell')
 */
export async function noteUncheckpointedSource(
  context: UncheckpointedSourceContext,
  source: UncheckpointedWriteSource | undefined
): Promise<void> {
  if (!source || !context.assistantMessageId) return;
  try {
    await recordUncheckpointedSource(context.db ?? getDb(), {
      chatId: context.chatId,
      messageId: context.assistantMessageId,
      source,
    });
  } catch (error) {
    logger.warn('uncheckpointed_source_not_recorded', {
      chatId: context.chatId,
      messageId: context.assistantMessageId,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
