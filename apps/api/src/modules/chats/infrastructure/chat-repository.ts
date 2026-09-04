import { isAgentId } from '@mangostudio/shared/agents';
import type {
  ChatRunnerConfiguration,
  ChatRunnerModelSelection,
  ChatRunnerPermissions,
} from '@mangostudio/shared/chat';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  isExternalAgentTargetId,
  normalizeApprovalRouting,
  normalizePermissionLevel,
  usableVendorId,
  vendorSelection,
} from '@mangostudio/shared/external-agents';
import type { Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';

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

/** Exactly what {@link toRunnerConfiguration} reads, so narrow selects qualify. */
type RunnerColumns = Pick<
  Selectable<Database['chats']>,
  'id' | 'runnerKind' | 'runnerAgentId' | 'runnerTargetId'
>;

/** Exactly what {@link toRunnerPermissions} reads. */
type RunnerPermissionColumns = Pick<
  Selectable<Database['chats']>,
  'runnerPermissionLevel' | 'runnerApprovalRouting'
>;

/**
 * Maps the two permission columns to the contract shape.
 *
 * NULL stays absent rather than becoming a default: the turn path normalizes an
 * unmade choice restrictively, and the selector has to be able to tell "nothing
 * chosen" from "read-only chosen" to show the vendor's own default instead of a
 * radio the user never pressed. A value that is no longer in the union is
 * dropped for the same reason — it is not a choice this build can honor.
 */
function toRunnerPermissions(row: RunnerPermissionColumns): ChatRunnerPermissions {
  const level = normalizePermissionLevel(row.runnerPermissionLevel);
  const routing = normalizeApprovalRouting(row.runnerApprovalRouting);
  return {
    ...(level.recognized ? { level: level.value } : {}),
    ...(routing.recognized ? { routing: routing.value } : {}),
  };
}

/** Exactly what {@link toRunnerModelSelection} reads. */
type RunnerModelColumns = Pick<Selectable<Database['chats']>, 'runnerModel' | 'runnerEffort'>;

/**
 * Maps the two model columns to the contract shape.
 *
 * NULL stays absent for the same reason it does above — the selector has to
 * distinguish "nothing chosen" from a choice — but there is no union to check a
 * present value against, and deliberately so: the catalog lives on the runtime,
 * so the API cannot know whether `opus` is still a model this vendor offers.
 * Reading it back unchanged is correct; `pickModel` is where a value the
 * catalog no longer lists is dropped, and the adapter is where one that is
 * unsafe on a command line is.
 *
 * Empty strings are treated as absent. A column holding one is not a choice
 * anybody made, and passing it on would put `--model ''` within reach.
 */
function toRunnerModelSelection(row: RunnerModelColumns): ChatRunnerModelSelection {
  return vendorSelection(row.runnerModel, row.runnerEffort);
}

/**
 * Maps the flat `runnerKind`/`runnerAgentId`/`runnerTargetId` columns to the
 * typed union at this boundary; nothing above the repository sees the flat
 * form. A row whose kind/companion-column pairing is impossible is corrupt
 * and throws loudly. A well-shaped but no-longer-resolvable agent id
 * (existence is checked when the turn resolves the profile, not here) is a
 * known shape with a missing referent, so it normalizes to `default` instead.
 */
function toRunnerConfiguration(row: RunnerColumns): ChatRunnerConfiguration {
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
    // Narrowed through the contract's own guard, never a list restated here:
    // the update route accepts any target `ExternalAgentTargetIdSchema` admits,
    // so a copy that fell behind it would make a chat this hub happily wrote
    // unreadable on every later read.
    if (!row.runnerTargetId || !isExternalAgentTargetId(row.runnerTargetId)) {
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
    runnerPermissions: toRunnerPermissions(row),
    runnerModelSelection: toRunnerModelSelection(row),
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
  runnerPermissions?: ChatRunnerPermissions;
  runnerModelSelection?: ChatRunnerModelSelection;
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
  runnerPermissions: ChatRunnerPermissions;
  runnerModelSelection: ChatRunnerModelSelection;
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

/** Exactly what the batched git state read consumes; narrow on purpose so a
 * corrupt runner column in one row cannot throw the whole batch away. It has to
 * keep satisfying that read's own `GitSummaryChat` port, which a unit test in
 * the git module holds it to. */
export type ChatWorkdirRow = Pick<
  Selectable<Database['chats']>,
  'id' | 'workdir' | 'environmentId'
>;

/**
 * Batch lookup filtered to one owner: ids that do not exist or belong to
 * another user are simply absent, so callers cannot tell the two apart.
 */
export async function listByIdsForUser(
  ids: readonly string[],
  userId: string,
  db: Kysely<Database>
): Promise<ChatWorkdirRow[]> {
  if (ids.length === 0) return [];
  return await db
    .selectFrom('chats')
    .select(['id', 'workdir', 'environmentId'])
    .where('id', 'in', [...ids])
    .where('userId', '=', userId)
    .execute();
}

/**
 * Ids of every chat one user has bound to the exact same workdir on the same
 * machine. A write through any of them changes what all of them read, so the
 * realtime layer fans its invalidation out to this set. Exact equality on
 * purpose: two checkouts of one repository are two working trees with
 * independent state, and `pr create` / `pr ready` never resolve a worktree
 * root to widen the match against, unlike `pr checkout`
 * ({@link listChatIdsUnderWorktreeRoot}).
 *
 * @example
 * const ids = await listChatIdsByWorkdir(userId, environmentId, workdir, db);
 */
export async function listChatIdsByWorkdir(
  userId: string,
  environmentId: string,
  workdir: string,
  db: Kysely<Database>
): Promise<string[]> {
  const rows = await db
    .selectFrom('chats')
    .select('id')
    .where('userId', '=', userId)
    .where('environmentId', '=', environmentId)
    .where('workdir', '=', workdir)
    .execute();
  return rows.map((row) => row.id);
}

/** True when `workdir` is `root` itself or a path underneath it. */
function isUnderWorktreeRoot(workdir: string, root: string): boolean {
  return workdir === root || workdir.startsWith(`${root}/`) || workdir.startsWith(`${root}\\`);
}

/**
 * Ids of every chat one user has bound to a workdir at or under a resolved
 * git worktree root, on one machine. `pr checkout` moves the shared HEAD,
 * index and working tree for the whole worktree, so a chat bound to a
 * subdirectory of it — a monorepo package, say — is exactly as stale as one
 * bound to the root itself, not just one bound to the identical string
 * (#944). Matched in application code rather than a `LIKE` prefix: `root`
 * comes from `git rev-parse --show-toplevel` and could contain `%` or `_`.
 *
 * @example
 * const ids = await listChatIdsUnderWorktreeRoot(userId, environmentId, root, db);
 */
export async function listChatIdsUnderWorktreeRoot(
  userId: string,
  environmentId: string,
  root: string,
  db: Kysely<Database>
): Promise<string[]> {
  const rows = await db
    .selectFrom('chats')
    .select(['id', 'workdir'])
    .where('userId', '=', userId)
    .where('environmentId', '=', environmentId)
    .where('workdir', 'is not', null)
    .execute();
  return rows
    .filter((row) => row.workdir !== null && isUnderWorktreeRoot(row.workdir, root))
    .map((row) => row.id);
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
    runnerPermissions: {},
    runnerModelSelection: {},
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
      runnerPermissionLevel: null,
      runnerModel: null,
      runnerEffort: null,
      runnerApprovalRouting: null,
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
  if (data.runner !== undefined) Object.assign(dbUpdates, runnerColumns(data.runner));
  if (data.runnerPermissions !== undefined) {
    // Written as a pair: the two axes compose into one configuration the adapter
    // vetted, and patching one while leaving the other stale is how an
    // unsupported combination reaches a vendor.
    dbUpdates.runnerPermissionLevel = data.runnerPermissions.level ?? null;
    dbUpdates.runnerApprovalRouting = data.runnerPermissions.routing ?? null;
  }
  if (data.runnerModelSelection !== undefined) {
    // Also a pair, for a different reason: an effort belongs to the model it
    // was chosen for, so keeping a stale one alongside a new model would send
    // the vendor a combination nobody picked.
    // Trimmed on the way in as well as on the way out, so the row never holds
    // a value the read path would reject as blank.
    dbUpdates.runnerModel = usableVendorId(data.runnerModelSelection.model) ?? null;
    dbUpdates.runnerEffort = usableVendorId(data.runnerModelSelection.effort) ?? null;
  }
  if (data.workdir !== undefined) dbUpdates.workdir = data.workdir;
  if (data.environmentId !== undefined) dbUpdates.environmentId = data.environmentId;
  if (data.restrictToolsToWorkdir !== undefined) {
    dbUpdates.restrictToolsToWorkdir =
      data.restrictToolsToWorkdir === null ? null : data.restrictToolsToWorkdir ? 1 : 0;
  }

  if (Object.keys(dbUpdates).length === 0) return;

  const runner = data.runner;
  if (runner === undefined) {
    await db
      .updateTable('chats')
      .set(dbUpdates)
      .where('id', '=', id)
      .where('userId', '=', userId)
      .execute();
    return;
  }

  const guardedWrite = async (trx: Kysely<Database>): Promise<void> => {
    await assertRunnerKindChangeAllowed(id, userId, runner.kind, trx);
    await trx
      .updateTable('chats')
      .set(dbUpdates)
      .where('id', '=', id)
      .where('userId', '=', userId)
      .execute();
  };

  // The D14 guard reads `messages` and then writes `chats`, so it only holds
  // if both happen under one transaction — otherwise the chat's first turn can
  // commit between the two statements and the kind changes anyway. SQLite
  // serializes writers, so the transaction alone closes the window.
  //
  // A caller that already opened one hands it in, and Kysely refuses to nest:
  // running the same two statements on it keeps the guarantee without the
  // second `BEGIN` that would throw.
  if (db.isTransaction) {
    await guardedWrite(db);
    return;
  }
  await db.transaction().execute(guardedWrite);
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
  runner: ChatRunnerConfiguration;
  runnerPermissions: ChatRunnerPermissions;
  runnerModelSelection: ChatRunnerModelSelection;
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
    .select([
      'id',
      'runnerKind',
      'runnerAgentId',
      'runnerTargetId',
      'runnerPermissionLevel',
      'runnerApprovalRouting',
      'runnerModel',
      'runnerEffort',
      'workdir',
      'environmentId',
      'restrictToolsToWorkdir',
    ])
    .where('id', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    runner: toRunnerConfiguration(row),
    runnerPermissions: toRunnerPermissions(row),
    runnerModelSelection: toRunnerModelSelection(row),
    workdir: row.workdir,
    environmentId: row.environmentId,
    restrictToolsToWorkdir: toOverrideFlag(row.restrictToolsToWorkdir),
  };
}
