import { isAgentId } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

const EXTERNAL_TARGET_IDS = ['codex', 'cursor', 'claude'] as const;

function isExternalTargetId(
  value: string
): value is Extract<ChatRunnerConfiguration, { kind: 'external' }>['targetId'] {
  return EXTERNAL_TARGET_IDS.some((targetId) => targetId === value);
}

class ChatRunnerCorruptionError extends Error {
  constructor(chatId: string, reason: string) {
    super(`Chat ${chatId} has a corrupt runner configuration: ${reason}`);
    this.name = 'ChatRunnerCorruptionError';
  }
}

export class RunnerKindImmutableError extends Error {
  constructor(chatId: string) {
    super(`Chat ${chatId} already has turns; runner kind cannot change.`);
    this.name = 'RunnerKindImmutableError';
  }
}

/** SQLite stores the tri-state override as NULL (inherit) or 0/1. */
function toOverrideFlag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

/**
 * Maps the flat `runnerKind`/`runnerAgentId`/`runnerTargetId` columns to the
 * typed union at this boundary; nothing above the repository sees the flat
 * form. A row whose kind/companion-column pairing is impossible is corrupt
 * and throws loudly. A well-shaped but no-longer-resolvable agent id
 * (existence is checked when the turn resolves the profile, not here) is a
 * known shape with a missing referent, so it normalizes to `default` instead.
 */
function toRunnerConfiguration(row: Selectable<Database['chats']>): ChatRunnerConfiguration {
  if (row.runnerKind === 'mangostudio') {
    if (!row.runnerAgentId) {
      throw new ChatRunnerCorruptionError(
        row.id,
        "runnerKind='mangostudio' requires a non-null runnerAgentId"
      );
    }
    if (!isAgentId(row.runnerAgentId)) {
      console.warn(
        `[chat-repository] chat ${row.id} has unresolvable runnerAgentId '${row.runnerAgentId}'; normalizing to 'default'`
      );
      return { kind: 'mangostudio', agentId: 'default' };
    }
    return { kind: 'mangostudio', agentId: row.runnerAgentId };
  }

  if (row.runnerKind === 'external') {
    if (!row.runnerTargetId || !isExternalTargetId(row.runnerTargetId)) {
      throw new ChatRunnerCorruptionError(
        row.id,
        "runnerKind='external' requires a valid runnerTargetId"
      );
    }
    return { kind: 'external', targetId: row.runnerTargetId };
  }

  throw new ChatRunnerCorruptionError(row.id, `unknown runnerKind '${row.runnerKind}'`);
}

function mapChatRow(row: Selectable<Database['chats']>): ChatRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    model: row.model,
    textModel: row.textModel,
    imageModel: row.imageModel,
    runner: toRunnerConfiguration(row),
    workdir: row.workdir,
    environmentId: row.environmentId,
    restrictToolsToWorkdir: toOverrideFlag(row.restrictToolsToWorkdir),
    userId: row.userId,
    lastProviderState: row.lastProviderState,
    lastContextState: row.lastContextState,
  };
}

export interface CreateChatData {
  title: string;
  model?: string | null;
  userId: string;
  environmentId?: string;
}

export interface UpdateChatData {
  title?: string;
  model?: string;
  textModel?: string;
  imageModel?: string;
  runner?: ChatRunnerConfiguration;
  workdir?: string | null;
  environmentId?: string;
  restrictToolsToWorkdir?: boolean | null;
}

export interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  runner: ChatRunnerConfiguration;
  workdir: string | null;
  environmentId: string;
  restrictToolsToWorkdir: boolean | null;
  userId: string | null;
  lastProviderState: string | null;
  lastContextState: string | null;
}

export async function listByUserId(userId: string, db: Kysely<Database>): Promise<ChatRecord[]> {
  const rows = await db
    .selectFrom('chats')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('updatedAt', 'desc')
    .execute();
  return rows.map(mapChatRow);
}

export async function getById(id: string, db: Kysely<Database>): Promise<ChatRecord | undefined> {
  const row = await db.selectFrom('chats').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? mapChatRow(row) : undefined;
}

function runnerColumns(
  runner: ChatRunnerConfiguration
): Pick<Updateable<Database['chats']>, 'runnerKind' | 'runnerAgentId' | 'runnerTargetId'> {
  return {
    runnerKind: runner.kind,
    runnerAgentId: runner.kind === 'mangostudio' ? runner.agentId : null,
    runnerTargetId: runner.kind === 'external' ? runner.targetId : null,
  };
}

export async function createChat(data: CreateChatData, db: Kysely<Database>): Promise<ChatRecord> {
  const now = Date.now();
  const chat: ChatRecord = {
    id: generateId(),
    title: data.title,
    createdAt: now,
    updatedAt: now,
    model: data.model ?? null,
    textModel: null,
    imageModel: null,
    runner: { kind: 'mangostudio', agentId: 'default' },
    workdir: null,
    environmentId: data.environmentId ?? LOCAL_ENVIRONMENT_ID,
    restrictToolsToWorkdir: null,
    userId: data.userId,
    lastProviderState: null,
    lastContextState: null,
  };
  await db
    .insertInto('chats')
    .values({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      model: chat.model,
      textModel: chat.textModel,
      imageModel: chat.imageModel,
      ...runnerColumns(chat.runner),
      workdir: chat.workdir,
      environmentId: chat.environmentId,
      restrictToolsToWorkdir: null,
      userId: chat.userId,
      lastProviderState: chat.lastProviderState,
      lastContextState: chat.lastContextState,
    })
    .execute();
  return chat;
}

/**
 * D14: a chat's transcript must never mix owners. Once a chat has at least
 * one persisted message, its runner `kind` is immutable — changing the agent
 * within `mangostudio` or the target within `external` stays allowed.
 */
async function assertRunnerKindChangeAllowed(
  chatId: string,
  userId: string,
  nextKind: ChatRunnerConfiguration['kind'],
  db: Kysely<Database>
): Promise<void> {
  const current = await db
    .selectFrom('chats')
    .select('runnerKind')
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!current || current.runnerKind === nextKind) return;

  const existingMessage = await db
    .selectFrom('messages')
    .select('id')
    .where('chatId', '=', chatId)
    .limit(1)
    .executeTakeFirst();
  if (existingMessage) {
    throw new RunnerKindImmutableError(chatId);
  }
}

export async function updateChat(
  id: string,
  userId: string,
  data: UpdateChatData,
  db: Kysely<Database>
): Promise<void> {
  const dbUpdates: Updateable<Database['chats']> = {};
  if (data.title !== undefined) dbUpdates.title = data.title;
  if (data.model !== undefined) dbUpdates.model = data.model;
  if (data.textModel !== undefined) dbUpdates.textModel = data.textModel;
  if (data.imageModel !== undefined) dbUpdates.imageModel = data.imageModel;
  if (data.runner !== undefined) {
    await assertRunnerKindChangeAllowed(id, userId, data.runner.kind, db);
    Object.assign(dbUpdates, runnerColumns(data.runner));
  }
  if (data.workdir !== undefined) dbUpdates.workdir = data.workdir;
  if (data.environmentId !== undefined) dbUpdates.environmentId = data.environmentId;
  if (data.restrictToolsToWorkdir !== undefined) {
    dbUpdates.restrictToolsToWorkdir =
      data.restrictToolsToWorkdir === null ? null : data.restrictToolsToWorkdir ? 1 : 0;
  }

  if (Object.keys(dbUpdates).length === 0) return;

  await db
    .updateTable('chats')
    .set(dbUpdates)
    .where('id', '=', id)
    .where('userId', '=', userId)
    .execute();
}

export async function deleteChat(id: string, userId: string, db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('chats').where('id', '=', id).where('userId', '=', userId).execute();
}

export async function verifyChatOwnership(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<boolean> {
  const chat = await db
    .selectFrom('chats')
    .select('userId')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return chat?.userId === userId;
}

/** Chat fields a generation turn needs; excludes the large persisted state blobs. */
export interface OwnedChatRecord {
  workdir: string | null;
  environmentId: string;
  restrictToolsToWorkdir: boolean | null;
}

export async function getOwnedChat(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChatRecord | undefined> {
  const row = await db
    .selectFrom('chats')
    .select(['workdir', 'environmentId', 'restrictToolsToWorkdir'])
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    workdir: row.workdir,
    environmentId: row.environmentId,
    restrictToolsToWorkdir: toOverrideFlag(row.restrictToolsToWorkdir),
  };
}
