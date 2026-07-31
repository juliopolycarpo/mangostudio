import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createEnvironmentRepository } from '../../environments/infrastructure/environment-repository';
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
  await updateChat(input.chatId, input.userId, updates, db);
}
