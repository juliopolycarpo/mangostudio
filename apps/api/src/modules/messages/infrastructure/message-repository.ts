import type { ChatAttachment, MessagesOrder } from '@mangostudio/shared/chat';
import type {
  GalleryItem,
  GeneratedImageArtifact,
  InteractionMode,
  MessagePart,
} from '@mangostudio/shared/types';
import { type Kysely, sql } from 'kysely';

import { boolToInt, parseStyleParams, serializeStyleParams } from '../../../db/serializers';
import type { Database } from '../../../db/types';
import { listAttachmentsByMessageIds } from '../../attachments/infrastructure/attachment-repository';
import { listGeneratedImagesByMessageIds } from '../../generated-images/infrastructure/generated-image-repository';
import { type GalleryCursor, type GalleryEntry, tiedRowidCeiling } from '../domain/gallery-cursor';
import { GeneratingMessageTextEditError } from '../domain/message-generating';
import { encodeTranscriptCursor, type TranscriptCursor } from '../domain/transcript-cursor';
import {
  deleteCheckpointDeltas,
  foldCheckpointDeltasIntoRows,
  withCheckpointSnapshot,
} from './message-checkpoint-deltas';
import { decodeMessageParts, readMessageParts } from './message-parts-codec';

export interface CreateMessageData {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string | null;
  referenceImage?: string | null;
  timestamp: number;
  isGenerating: boolean;
  generationTime?: string | null;
  modelName?: string | null;
  styleParams?: string[] | null;
  interactionMode: InteractionMode;
  parts?: string | null;
  providerState?: string | null;
}

export interface UpdateMessageData {
  text?: string;
  imageUrl?: string | null;
  isGenerating?: boolean;
  generationTime?: string | null;
  modelName?: string | null;
  styleParams?: string[] | null;
  parts?: string | null;
  providerState?: string | null;
}

interface MessageRow {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: number;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string | null;
  interactionMode: InteractionMode;
  parts: string | null;
  providerState: string | null;
}

interface MappedMessage {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  isGenerating: boolean;
  generationTime: string | null;
  modelName: string | null;
  styleParams: string[] | undefined;
  interactionMode: InteractionMode;
  parts: MessagePart[] | undefined;
  providerState: string | null;
  generatedImages: GeneratedImageArtifact[] | undefined;
  attachments: ChatAttachment[] | undefined;
}

interface SimpleTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

interface RichTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
  parts?: MessagePart[];
  providerState?: string | null;
  modelName?: string | null;
}

interface ListByChatOptions {
  cursor?: TranscriptCursor;
  limit?: number;
  /** `asc` (the default) reads from the oldest row, `desc` from the newest. */
  order?: MessagesOrder;
}

interface ListHistoryOptions {
  excludeId?: string;
  excludeIds?: readonly string[];
  limit?: number;
}

interface ListGalleryOptions {
  /** Position of the last image of the previous page; only later ones are returned. */
  cursor?: GalleryCursor;
  limit?: number;
}

const CONTEXT_BOUNDARY_EVENTS = new Set(['chat_compacted', 'summary_handoff']);

function collectExcludedIds(opts: ListHistoryOptions): string[] {
  return [...new Set([...(opts.excludeIds ?? []), ...(opts.excludeId ? [opts.excludeId] : [])])];
}

function mapMessage(
  row: MessageRow,
  generatedImages?: GeneratedImageArtifact[],
  attachments?: ChatAttachment[]
): MappedMessage {
  return {
    ...row,
    isGenerating: row.isGenerating === 1,
    styleParams: parseStyleParams(row.styleParams),
    parts: readMessageParts(row),
    generatedImages,
    attachments,
  };
}

/**
 * `parts` as the text history selects it: the stored cell when it names a
 * context boundary event, `NULL` otherwise. Text history reads `parts` only to
 * find that boundary, and a tool result can run to tens of KB, so the other
 * cells stay inside SQLite instead of being copied out and parsed for nothing.
 * The substring test only narrows the candidates; a row that names an event in
 * prose is still decoded and rejected by {@link sliceRowsAfterCompactionBoundary}.
 *
 * A generating row always carries its cell: its checkpoint deltas fold over it
 * (see {@link foldCheckpointDeltasIntoRows}), and the fold needs the base.
 */
const boundaryCandidateParts = sql<string | null>`CASE WHEN isGenerating = 1 OR ${sql.join(
  [...CONTEXT_BOUNDARY_EVENTS].map((event) => sql`instr(parts, ${event}) > 0`),
  sql` OR `
)} THEN parts END`;

/**
 * Drops the rows older than the newest context boundary. A corrupt `parts`
 * cell cannot mark a boundary, so it is skipped without a warning here: the
 * read that actually uses a row's parts (the transcript page, the rich
 * history) is the one that reports it.
 */
function sliceRowsAfterCompactionBoundary<T extends { parts: string | null }>(rows: T[]): T[] {
  for (let index = rows.length - 1; index >= 0; index--) {
    const decoded = decodeMessageParts(rows[index].parts);
    if (decoded.kind !== 'ok') continue;

    const hasBoundary = decoded.parts.some(
      (part) => part.type === 'system_event' && CONTEXT_BOUNDARY_EVENTS.has(part.event)
    );
    if (hasBoundary) return rows.slice(index);
  }

  return rows;
}

export async function insertMessage(data: CreateMessageData, db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: data.id,
      chatId: data.chatId,
      role: data.role,
      text: data.text,
      imageUrl: data.imageUrl ?? null,
      referenceImage: data.referenceImage ?? null,
      timestamp: data.timestamp,
      isGenerating: boolToInt(data.isGenerating),
      generationTime: data.generationTime ?? null,
      modelName: data.modelName ?? null,
      styleParams: serializeStyleParams(data.styleParams),
      interactionMode: data.interactionMode,
      parts: data.parts ?? null,
      providerState: data.providerState ?? null,
    })
    .execute();
}

export async function updateMessage(
  id: string,
  data: UpdateMessageData,
  db: Kysely<Database>
): Promise<void> {
  const updates: {
    text?: string;
    imageUrl?: string | null;
    isGenerating?: 0 | 1;
    generationTime?: string | null;
    modelName?: string | null;
    styleParams?: string | null;
    parts?: string | null;
    providerState?: string | null;
  } = {};

  if (data.text !== undefined) updates.text = data.text;
  if (data.imageUrl !== undefined) updates.imageUrl = data.imageUrl;
  if (data.isGenerating !== undefined) updates.isGenerating = boolToInt(data.isGenerating);
  if (data.generationTime !== undefined) updates.generationTime = data.generationTime;
  if (data.modelName !== undefined) updates.modelName = data.modelName;
  if (data.styleParams !== undefined) updates.styleParams = serializeStyleParams(data.styleParams);
  if (data.parts !== undefined) updates.parts = data.parts;
  if (data.providerState !== undefined) updates.providerState = data.providerState;

  if (Object.keys(updates).length === 0) return;

  // Only these columns are shaped by a generating turn's checkpoint deltas.
  const touchesCheckpointed =
    'text' in updates ||
    'parts' in updates ||
    'providerState' in updates ||
    'generationTime' in updates ||
    'isGenerating' in updates;
  if (!touchesCheckpointed) {
    await db.updateTable('messages').set(updates).where('id', '=', id).execute();
    return;
  }

  // A generating row's columns are its last full rewrite; its newer content is in
  // the deltas. Fold them into the row first, then apply the patch on top and drop
  // them, so that neither clearing `isGenerating` (which deletes the deltas) nor
  // editing `text` (which deltas would otherwise be appended to) loses or garbles
  // what the turn had checkpointed.
  await withCheckpointSnapshot(db, async (trx) => {
    const stored = await trx
      .selectFrom('messages')
      .select(['id', 'text', 'parts', 'providerState', 'generationTime', 'isGenerating'])
      .where('id', '=', id)
      .executeTakeFirst();
    let merged: typeof updates = updates;
    // The live writer holds its own view of the stored text and appends deltas to it, so
    // an edit that leaves the turn generating would be extended with the old content's
    // continuation. Refuse it; an edit that also settles the turn is safe, because the
    // writer's next delta is guarded on `isGenerating = 1`.
    if (stored?.isGenerating === 1 && 'text' in updates && updates.isGenerating !== 0) {
      throw new GeneratingMessageTextEditError(id);
    }
    if (stored?.isGenerating === 1) {
      const [folded] = await foldCheckpointDeltasIntoRows([stored], trx);
      if (folded && folded !== stored) {
        merged = {
          text: folded.text,
          parts: folded.parts,
          providerState: folded.providerState,
          generationTime: folded.generationTime ?? null,
          ...updates,
        };
        await deleteCheckpointDeltas(id, trx);
      }
    }
    await trx.updateTable('messages').set(merged).where('id', '=', id).execute();
  });
}

/**
 * Pages a chat transcript by `(timestamp, rowid)`: from the oldest row with
 * `order: 'asc'` (the default), from the newest with `order: 'desc'`.
 *
 * `timestamp` is not unique (a user turn and its reply can share a
 * millisecond), so `rowid` breaks ties in insertion order and the cursor
 * carries both values. Any index serving the order must end in `timestamp`
 * after `chatId`; SQLite appends `rowid` to every index.
 *
 * Both orders return each page chronological, oldest row first. `nextCursor`
 * is the position of the page's edge that faces the unread rows: the last row
 * for `asc`, the first (oldest) row for `desc`. Reading `desc`, the rows before
 * the cursor come next, so a page boundary that splits a timestamp tie is
 * crossed without repeating or skipping a row.
 *
 * @example
 * const page = await listByChatId(chatId, { limit: 50 }, db);
 * const next = await listByChatId(chatId, { limit: 50, cursor: decodeTranscriptCursor(page.nextCursor) }, db);
 * const newest = await listByChatId(chatId, { limit: 50, order: 'desc' }, db);
 */
export async function listByChatId(
  chatId: string,
  opts: ListByChatOptions,
  db: Kysely<Database>
): Promise<{ messages: MappedMessage[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 50;
  const newestFirst = opts.order === 'desc';
  const direction = newestFirst ? 'desc' : 'asc';

  const pageQuery = (from: Kysely<Database>) => {
    let q = from
      .selectFrom('messages')
      .selectAll()
      .select(sql<number>`rowid`.as('rowid'))
      .where('chatId', '=', chatId)
      .orderBy('timestamp', direction)
      .orderBy(sql`rowid`, direction);

    if (opts.cursor) {
      const { timestamp, rowid } = opts.cursor;
      q = q.where(
        newestFirst
          ? sql<boolean>`(timestamp, rowid) < (${timestamp}, ${rowid})`
          : sql<boolean>`(timestamp, rowid) > (${timestamp}, ${rowid})`
      );
    }
    return q.limit(limit + 1);
  };

  // A row still generating is read as its last checkpoint left it, not as its
  // last full rewrite. The page and those deltas are read together.
  const { fetched, rows } = await withCheckpointSnapshot(db, async (snapshot) => {
    const page = await pageQuery(snapshot).execute();
    // The look-ahead row proves another page exists and is not part of this one.
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    const folded = await foldCheckpointDeltasIntoRows(
      page.map(({ rowid: _rowid, ...row }) => row),
      snapshot
    );
    return { fetched: { page, hasMore }, rows: folded };
  });

  // `fetched.page` is in query order, so its last row is the edge facing the next page.
  let nextCursor: string | null = null;
  if (fetched.hasMore) {
    const edge = fetched.page.at(-1);
    nextCursor = edge
      ? encodeTranscriptCursor({ timestamp: edge.timestamp, rowid: edge.rowid })
      : null;
  }
  // A page is chronological whichever end it was cut from. `rows` is in query order too.
  if (newestFirst) rows.reverse();

  const messageIds = rows.map((row) => row.id);
  const [generatedImagesByMessageId, attachmentsByMessageId] = await Promise.all([
    listGeneratedImagesByMessageIds(messageIds, db),
    listAttachmentsByMessageIds(messageIds, db),
  ]);

  return {
    messages: rows.map((row) =>
      mapMessage(row, generatedImagesByMessageId.get(row.id), attachmentsByMessageId.get(row.id))
    ),
    nextCursor,
  };
}

/**
 * Text history excludes image turns and nothing else. The predicate is
 * negative rather than an allow-list of `chat`/`agent` because the message
 * mode no longer names an interaction the product has: `chat` only appears on
 * rows written before the mode axis was retired and by the non-streaming
 * `POST /respond` path, while every streamed turn writes `agent`. Matching on
 * either literal would silently drop the other half of a chat's transcript.
 *
 * The newest rows are taken `timestamp DESC, rowid DESC`: a limit that splits
 * rows sharing a timestamp keeps the newest of them, and the reversed window
 * reads in insertion order.
 *
 * Only boundary candidates carry `parts` (see {@link boundaryCandidateParts});
 * the turns returned are text, so a corrupt cell is not reported from here.
 *
 * A row still generating is read as its last checkpoint left it: its stored
 * `text` is only as new as the turn's last full rewrite. A second turn in the
 * same chat, `POST /respond` and compaction all reach such a row, and
 * compaction would bake the stale text into its summary for good.
 */
export async function loadHistory(
  chatId: string,
  opts: ListHistoryOptions,
  db: Kysely<Database>
): Promise<SimpleTurn[]> {
  const excludedIds = collectExcludedIds(opts);
  const rows = await withCheckpointSnapshot(db, async (snapshot) => {
    let q = snapshot
      .selectFrom('messages')
      .select([
        'id',
        'role',
        'text',
        'isGenerating',
        sql<string | null>`NULL`.as('providerState'),
        boundaryCandidateParts.as('parts'),
      ])
      .where('chatId', '=', chatId)
      .where('interactionMode', '!=', 'image')
      .orderBy('timestamp', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .limit(opts.limit ?? 200);
    if (excludedIds.length > 0) q = q.where('id', 'not in', excludedIds);
    return foldCheckpointDeltasIntoRows(await q.execute(), snapshot);
  });

  return sliceRowsAfterCompactionBoundary(rows.reverse()).map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
  }));
}

/** Same text-history predicate as {@link loadHistory}, and the same fold of a generating row. */
export async function loadRichHistory(
  chatId: string,
  opts: ListHistoryOptions,
  db: Kysely<Database>
): Promise<RichTurn[]> {
  const excludedIds = collectExcludedIds(opts);
  const fetched = await withCheckpointSnapshot(db, async (snapshot) => {
    let q = snapshot
      .selectFrom('messages')
      .select(['id', 'role', 'text', 'parts', 'providerState', 'modelName', 'isGenerating'])
      .where('chatId', '=', chatId)
      .where('interactionMode', '!=', 'image')
      .orderBy('timestamp', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .limit(opts.limit ?? 200);
    if (excludedIds.length > 0) q = q.where('id', 'not in', excludedIds);
    return foldCheckpointDeltasIntoRows(await q.execute(), snapshot);
  });
  const rows = sliceRowsAfterCompactionBoundary(fetched.reverse());

  // A corrupt message stays in the history as plain text (`parts` undefined): its
  // `text` is the same denormalized copy `loadHistory` sends, and dropping the
  // turn would break the user/assistant alternation providers expect.
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    parts: readMessageParts(row),
    providerState: row.providerState ?? null,
    modelName: row.modelName ?? null,
  }));
}

export async function verifyMessageOwnership(
  messageId: string,
  userId: string,
  db: Kysely<Database>
): Promise<boolean> {
  const msg = await db
    .selectFrom('messages')
    .innerJoin('chats', 'chats.id', 'messages.chatId')
    .select(['messages.id', 'chats.userId'])
    .where('messages.id', '=', messageId)
    .executeTakeFirst();

  return !!msg && msg.userId === userId;
}

/**
 * Lists the legacy gallery images (an `ai` message carrying `imageUrl` with no
 * `generated_images` row) newest first, ordered by `(timestamp, rowid)`
 * descending: `timestamp` is not unique, so the message `rowid` breaks the tie
 * in insertion order. Entries carry the `rowid` and the `message` source for
 * the merged gallery cursor.
 *
 * @example
 * const entries = await listLegacyGalleryImages(userId, { limit: 50, cursor }, db);
 */
export async function listLegacyGalleryImages(
  userId: string,
  opts: ListGalleryOptions,
  db: Kysely<Database>
): Promise<GalleryEntry<GalleryItem>[]> {
  const limit = opts.limit ?? 50;

  let query = db
    .selectFrom('messages as ai')
    .innerJoin('chats', 'ai.chatId', 'chats.id')
    .select([
      'ai.id',
      'ai.imageUrl',
      'ai.chatId',
      'ai.timestamp',
      'ai.modelName',
      'ai.generationTime',
      sql<number>`ai.rowid`.as('rowid'),
      (eb) =>
        eb
          .selectFrom('messages as user_msg')
          .select('user_msg.text')
          .whereRef('user_msg.chatId', '=', 'ai.chatId')
          .where('user_msg.role', '=', 'user')
          .where('user_msg.timestamp', '<=', eb.ref('ai.timestamp'))
          .orderBy('user_msg.timestamp', 'desc')
          .limit(1)
          .as('prompt'),
    ])
    .where('chats.userId', '=', userId)
    .where('ai.role', '=', 'ai')
    .where('ai.imageUrl', 'is not', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('generated_images as artifact')
            .select('artifact.id')
            .whereRef('artifact.messageId', '=', 'ai.id')
            .whereRef('artifact.imageUrl', '=', 'ai.imageUrl')
        )
      )
    )
    .orderBy('ai.timestamp', 'desc')
    .orderBy(sql`ai.rowid`, 'desc');

  if (opts.cursor) {
    const ceiling = tiedRowidCeiling('message', opts.cursor);
    query = query.where(
      sql<boolean>`(ai.timestamp, ai.rowid) < (${opts.cursor.createdAt}, ${ceiling})`
    );
  }

  const rows = await query.limit(limit + 1).execute();

  return rows
    .filter((row): row is typeof row & { imageUrl: string } => row.imageUrl !== null)
    .map((row) => ({
      item: {
        id: row.id,
        messageId: row.id,
        imageUrl: row.imageUrl,
        prompt: row.prompt ?? 'Generated Image',
        chatId: row.chatId,
        createdAt: row.timestamp,
        modelName: row.modelName ?? undefined,
        generationTime: row.generationTime ?? undefined,
      },
      source: 'message',
      rowid: row.rowid,
    }));
}
