import { isAbsolute, relative, resolve } from 'node:path';
import type { ExternalAgentAttachment } from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_ATTACHMENT_MAX_BYTES,
  EXTERNAL_TURN_MAX_ATTACHMENTS,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';
import type { ChatAttachmentSelect, Database } from '../../../db/types';
import { getConfig } from '../../../lib/config';
import { attachmentToBase64 } from '../../../services/providers/core/attachment-content';
import type { ProviderRuntimeAttachment } from '../../../services/providers/types';
import { assertChatAttachmentIdsAvailable } from '../infrastructure/attachment-repository';

export class ChatAttachmentFileUnavailableError extends Error {
  constructor() {
    super('One or more attachment files could not be loaded.');
    this.name = 'ChatAttachmentFileUnavailableError';
  }
}

export async function resolveProviderRuntimeAttachments(
  input: {
    attachmentIds: string[];
    userId: string;
    chatId: string;
    /**
     * Optional, because an external turn resolves its attachments *before* the
     * message row exists — the bytes have to be in hand before the response is
     * committed, or a missing file becomes a stream that opens and then dies.
     * `assertChatAttachmentIdsAvailable` has always accepted an absent one; the
     * ownership check that matters is the chat's, not the message's.
     */
    messageId?: string;
  },
  db: Kysely<Database>
): Promise<ProviderRuntimeAttachment[]> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  if (attachmentIds.length === 0) return [];

  const rows = await assertChatAttachmentIdsAvailable(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    db
  );

  return loadAttachmentBytes(attachmentIds, rows);
}

/**
 * Reads the bytes for rows an ownership check has already returned.
 *
 * Split out so a caller that must inspect the rows first — the external-agent
 * path, which refuses a set before loading any of it — can do so without
 * running the same ownership query a second time.
 */
function loadAttachmentBytes(
  attachmentIds: readonly string[],
  rows: readonly ChatAttachmentSelect[]
): Promise<ProviderRuntimeAttachment[]> {
  const rowsById = new Map(rows.map((attachment) => [attachment.id, attachment]));
  const uploadsRoot = resolve(getConfig().uploads.dir);

  return Promise.all(
    attachmentIds.map(async (attachmentId) => {
      const attachment = rowsById.get(attachmentId);
      if (!attachment) throw new ChatAttachmentFileUnavailableError();

      const absolutePath = resolveAttachmentPath(uploadsRoot, attachment.relativePath);
      const file = Bun.file(absolutePath);
      if (!(await file.exists())) throw new ChatAttachmentFileUnavailableError();

      const bytes = new Uint8Array(await file.arrayBuffer());
      return mapRuntimeAttachment(attachment, bytes);
    })
  );
}

function resolveAttachmentPath(uploadsRoot: string, attachmentRelativePath: string): string {
  if (!attachmentRelativePath.trim() || isAbsolute(attachmentRelativePath)) {
    throw new ChatAttachmentFileUnavailableError();
  }

  const absolutePath = resolve(uploadsRoot, attachmentRelativePath);
  const pathFromRoot = relative(uploadsRoot, absolutePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new ChatAttachmentFileUnavailableError();
  }

  return absolutePath;
}

function mapRuntimeAttachment(
  attachment: ChatAttachmentSelect,
  bytes: Uint8Array
): ProviderRuntimeAttachment {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    bytes,
  };
}

function uniqueAttachmentIds(attachmentIds: string[]): string[] {
  return Array.from(new Set(attachmentIds.filter((id) => id.trim().length > 0)));
}

/**
 * Why a set of attachments cannot cross to a vendor.
 *
 * Named rather than thrown, because each one is a different sentence to a
 * different person: `non-image` is "this agent takes pictures, not documents",
 * and the two bounds are "MangoStudio will not send that much". A thrown error
 * would collapse them into the one message that already means "the file could
 * not be read".
 */
export type ExternalAgentAttachmentRefusal = 'non-image' | 'too-many' | 'too-large';

export type ExternalAgentAttachmentResolution =
  | { readonly ok: true; readonly attachments: ExternalAgentAttachment[] }
  | { readonly ok: false; readonly refusal: ExternalAgentAttachmentRefusal };

/**
 * The same attachments, shaped for an external agent's own wire.
 *
 * Three differences from the provider path above, and all three are the
 * vendors':
 *
 * - **Images only, and said so.** Codex maps every attachment it is given as an
 *   image regardless of kind, so handing it a PDF would send a broken image
 *   rather than a document. Anything else is *refused* rather than filtered
 *   out: dropping it silently would let the agent answer confidently about a
 *   file it never received, which is the one outcome worse than not sending.
 * - **Bounded to what the runtime's schema accepts.** A chat attachment may be
 *   20 MB and a turn may name twenty of them, while
 *   `ExternalAgentTurnParamsSchema` takes four of at most
 *   `EXTERNAL_ATTACHMENT_MAX_BYTES`. Checked here, against the same constants
 *   that schema uses, and checked *before* a byte is read — a refusal the
 *   runtime raises instead arrives after the response is already a stream.
 * - **Base64, not bytes.** The runtime protocol is JSON, so the schema takes an
 *   encoded string.
 *
 * Reuses `resolveProviderRuntimeAttachments`, so the traversal guard and the
 * "file is gone" failure are the same ones the internal path has rather than a
 * second implementation of both.
 *
 * @example
 * const resolved = await resolveExternalAgentAttachments(
 *   { attachmentIds, userId, chatId },
 *   db
 * );
 * if (!resolved.ok) return refuse(resolved.refusal);
 */
export async function resolveExternalAgentAttachments(
  input: {
    attachmentIds: string[];
    userId: string;
    chatId: string;
    messageId?: string;
  },
  db: Kysely<Database>
): Promise<ExternalAgentAttachmentResolution> {
  const attachmentIds = uniqueAttachmentIds(input.attachmentIds);
  const rows = await assertChatAttachmentIdsAvailable(
    {
      attachmentIds,
      userId: input.userId,
      chatId: input.chatId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    },
    db
  );
  const refusal = refusalFor(rows);
  if (refusal) return { ok: false, refusal };

  const resolved = await loadAttachmentBytes(attachmentIds, rows);
  return {
    ok: true,
    attachments: resolved.map((attachment) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: 'image' as const,
      bytesBase64: attachmentToBase64(attachment),
    })),
  };
}

/** Read off the rows, so nothing is loaded for a set that cannot be sent. */
function refusalFor(rows: readonly ChatAttachmentSelect[]): ExternalAgentAttachmentRefusal | null {
  if (rows.some((row) => row.kind !== 'image')) return 'non-image';
  if (rows.length > EXTERNAL_TURN_MAX_ATTACHMENTS) return 'too-many';
  if (rows.some((row) => row.sizeBytes > EXTERNAL_ATTACHMENT_MAX_BYTES)) return 'too-large';
  return null;
}
