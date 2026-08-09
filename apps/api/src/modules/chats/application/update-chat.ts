import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createEnvironmentRepository } from '../../environments/infrastructure/environment-repository';
import { externalSessionManager } from '../../external-agents/application/external-session-manager';
import { requireValidWorkdir } from '../../workspaces/application/workdir-validation';
import { getOwnedChatOrThrow } from '../domain/chat-ownership';
import { type UpdateChatData, updateChat } from '../infrastructure/chat-repository';

export interface UpdateChatInput {
  chatId: string;
  userId: string;
  updates: UpdateChatData;
}

export class EnvironmentSelectionError extends Error {
  constructor(environmentId: string) {
    super(`Environment "${environmentId}" was not found.`);
    this.name = 'EnvironmentSelectionError';
  }
}

export async function updateChatUseCase(
  input: UpdateChatInput,
  db: Kysely<Database>
): Promise<void> {
  const current = await getOwnedChatOrThrow(input.chatId, input.userId, db);
  const updates = { ...input.updates };
  const environmentId = updates.environmentId ?? current.environmentId;

  // Reject an unknown target before workdir validation, which would otherwise
  // try to reach it and report an unavailable runtime instead. The write below
  // re-checks; this one is only here for the error the caller sees.
  if (
    environmentId !== LOCAL_ENVIRONMENT_ID &&
    !(await createEnvironmentRepository(db).find(input.userId, environmentId))
  ) {
    throw new EnvironmentSelectionError(environmentId);
  }

  if (
    updates.environmentId !== undefined &&
    updates.environmentId !== current.environmentId &&
    updates.workdir === undefined
  ) {
    updates.workdir = null;
  }

  if (updates.workdir !== undefined && updates.workdir !== null) {
    updates.workdir = await requireValidWorkdir(updates.workdir, {
      userId: input.userId,
      environmentId,
    });
  }

  // Workdir validation talks to the runtime, so it cannot run inside the write
  // transaction. Re-check the environment inside it instead: deletion refuses
  // an environment any chat references, from its own transaction, so pairing
  // the two makes "selectable" and "deletable" mutually exclusive rather than
  // letting a delete land between the check above and this write.
  await db.transaction().execute(async (transaction) => {
    if (
      environmentId !== LOCAL_ENVIRONMENT_ID &&
      !(await createEnvironmentRepository(transaction).find(input.userId, environmentId))
    ) {
      throw new EnvironmentSelectionError(environmentId);
    }
    await updateChat(input.chatId, input.userId, updates, transaction);
  });

  // Environment, workspace and vendor are part of an external session's
  // identity, so a change to any of them invalidates the vendor conversation
  // rather than moving it. The target matters as much as the other two: a chat
  // may be repointed at another vendor even after it has messages, and a live
  // turn from the old one would otherwise keep writing into a chat that is now
  // bound to a different vendor. Done after the write: the binding it is
  // reacting to is the persisted one.
  const bindingChanged =
    (updates.environmentId !== undefined && updates.environmentId !== current.environmentId) ||
    (updates.workdir !== undefined && updates.workdir !== current.workdir) ||
    externalTargetChanged(current.runner, updates.runner);
  if (bindingChanged) {
    await externalSessionManager.reapChat(input.chatId, 'session-lost');
  }
}

/**
 * True when the chat stops being run by the vendor its session was opened for.
 *
 * A change away from `external` is covered too: the session belongs to a runner
 * the chat no longer has either way.
 */
function externalTargetChanged(
  current: ChatRunnerConfiguration,
  next: ChatRunnerConfiguration | undefined
): boolean {
  if (current.kind !== 'external' || next === undefined) return false;
  return next.kind !== 'external' || next.targetId !== current.targetId;
}
