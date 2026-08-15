import {
  RUNTIME_ABSENT_HASH,
  RuntimeSnapshotConflictError,
  type RuntimeSnapshotRevertParams,
} from '@mangostudio/runtime';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import type { Database, FileCheckpointSelect } from '../../../db/types';
import { getRuntimeClient } from '../../../services/runtime-client';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import {
  buildWorkdirPolicy,
  resolveEffectiveRestrictToolsToWorkdir,
} from '../../workspaces/application/workdir-policy';
import { readCheckpointBlob } from '../infrastructure/checkpoint-blob-store';
import {
  listActiveCheckpointsForMessage,
  markMessageCheckpointsReverted,
} from '../infrastructure/checkpoint-repository';

export class FileCheckpointConflictError extends Error {
  constructor(
    readonly resolvedPath: string,
    message = `Cannot revert "${resolvedPath}": the file changed on disk since this assistant message completed.`
  ) {
    super(message);
    this.name = 'FileCheckpointConflictError';
  }
}

export async function revertMessageFileCheckpoints(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<{ revertedFiles: number }> {
  const rows = await listActiveCheckpointsForMessage(db, chatId, messageId);
  if (rows.length === 0) return { revertedFiles: 0 };

  const operations = await buildRevertOperations(rows);
  const reverted = revertedStateByPath(rows);
  const expected = [...finalStateByPath(rows)].map(([path, afterHash]) => {
    const revertedHash = reverted.get(path);
    return { path, afterHash, ...(revertedHash === undefined ? {} : { revertedHash }) };
  });
  const runtimeContext = await resolveRevertRuntimeContext(
    db,
    chatId,
    checkpointEnvironmentId(rows)
  );
  const runtime = await getRuntimeClient(runtimeContext.userId, runtimeContext.environmentId);
  let result: { revertedFiles: number };
  try {
    result = await runtime.snapshot.revert({
      chatId,
      expected,
      operations,
      ...(runtimeContext.containmentRoot
        ? { containmentRoot: runtimeContext.containmentRoot }
        : {}),
    });
  } catch (error) {
    if (error instanceof RuntimeSnapshotConflictError) {
      throw new FileCheckpointConflictError(error.resolvedPath);
    }
    throw error;
  }

  await markMessageCheckpointsReverted(db, chatId, messageId, Date.now());
  return result;
}

/**
 * Every row a message wrote was captured against one environment. Reverting
 * elsewhere would replay that host's absolute paths on another, so a mixed set
 * is a corrupt manifest rather than something to pick a winner from.
 */
function checkpointEnvironmentId(rows: readonly FileCheckpointSelect[]): string {
  const environmentIds = new Set(rows.map((row) => row.environmentId));
  if (environmentIds.size > 1) {
    throw new Error(
      `Checkpoints for this message span multiple environments: ${[...environmentIds].join(', ')}.`
    );
  }
  return rows[0]?.environmentId ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * When tools are restricted to the chat workdir, revert uses the same runtime
 * containment root so checkpoint paths cannot escape after the fact.
 */
async function resolveRevertRuntimeContext(
  db: Kysely<Database>,
  chatId: string,
  environmentId: string
): Promise<{
  userId: string;
  environmentId: string;
  containmentRoot?: string;
}> {
  const chat = await db
    .selectFrom('chats')
    .select(['userId', 'environmentId', 'workdir', 'restrictToolsToWorkdir'])
    .where('id', '=', chatId)
    .executeTakeFirst();
  if (!chat?.userId) {
    throw new Error(`Cannot resolve runtime for missing chat "${chatId}".`);
  }

  const base = { userId: chat.userId, environmentId };
  // The workdir policy describes wherever the chat points now. Once that is a
  // different environment it says nothing about the host these paths came from,
  // so it is not a boundary those checkpoints can be checked against.
  if (chat.environmentId !== environmentId || !chat.workdir) return base;

  const appSettings = await getAppSettings(db, chat.userId);
  const chatOverride =
    chat.restrictToolsToWorkdir === null ? null : chat.restrictToolsToWorkdir !== 0;
  const restricted = resolveEffectiveRestrictToolsToWorkdir(
    appSettings.workspaceSettings?.restrictToolsToWorkdir ??
      DEFAULT_WORKSPACE_SETTINGS.restrictToolsToWorkdir,
    chatOverride
  );
  const policy = buildWorkdirPolicy(chat.workdir, restricted);
  return policy?.restricted ? { ...base, containmentRoot: policy.root } : base;
}

async function buildRevertOperations(
  rows: readonly FileCheckpointSelect[]
): Promise<RuntimeSnapshotRevertParams['operations']> {
  const operations: RuntimeSnapshotRevertParams['operations'][number][] = [];
  for (const row of [...rows].reverse()) {
    switch (row.op) {
      case 'create':
        operations.push({ type: 'create', path: row.path });
        break;
      case 'delete':
      case 'edit':
        operations.push({
          type: 'restore',
          path: row.path,
          contentBase64: await readRequiredBlob(row),
        });
        break;
      case 'move':
        if (!row.movedTo) throw new FileCheckpointConflictError(row.path);
        operations.push({
          type: 'move',
          path: row.path,
          movedTo: row.movedTo,
          contentBase64: await readRequiredBlob(row),
        });
        break;
      default:
        throw new Error(`Unknown checkpoint op: ${row.op}`);
    }
  }
  return operations;
}

async function readRequiredBlob(row: FileCheckpointSelect): Promise<string> {
  if (!row.blobKey) {
    throw new FileCheckpointConflictError(
      row.path,
      `Cannot revert "${row.path}": its content before this assistant message was not captured, ` +
        'so there is nothing to restore.'
    );
  }
  const bytes = await readCheckpointBlob(row.blobKey);
  if (!bytes) {
    throw new FileCheckpointConflictError(
      row.path,
      `Cannot revert "${row.path}": its stored content from before this assistant message is no ` +
        'longer available.'
    );
  }
  return Buffer.from(bytes).toString('base64');
}

/**
 * Replays the message's rows to derive what it left on disk, path by path. Only
 * these final states are safe to compare before reverting.
 */
function finalStateByPath(rows: readonly FileCheckpointSelect[]): Map<string, string> {
  const expected = new Map<string, string>();
  for (const row of rows) {
    const afterHash = row.afterHash ?? RUNTIME_ABSENT_HASH;
    if (row.movedTo) {
      expected.set(row.path, RUNTIME_ABSENT_HASH);
      expected.set(row.movedTo, afterHash);
    } else {
      expected.set(row.path, afterHash);
    }
  }
  return expected;
}

/**
 * The mirror image of {@link finalStateByPath}: what a completed revert leaves
 * on disk. Undoing a row hands its path back its captured `beforeHash` and
 * empties whatever it had moved content to, so replaying the rows backwards —
 * the order revert itself uses — lands on the earliest state of every path.
 *
 * A revert whose bookkeeping write failed leaves exactly this, and it is what
 * lets the retry tell its own finished work apart from an outside edit.
 */
function revertedStateByPath(rows: readonly FileCheckpointSelect[]): Map<string, string> {
  const reverted = new Map<string, string>();
  for (const row of [...rows].reverse()) {
    if (row.movedTo) reverted.set(row.movedTo, RUNTIME_ABSENT_HASH);
    reverted.set(
      row.path,
      row.op === 'create' ? RUNTIME_ABSENT_HASH : (row.beforeHash ?? RUNTIME_ABSENT_HASH)
    );
  }
  return reverted;
}
