/**
 * Chat-scoped file uploads, for the composer's paste and drop paths.
 *
 * The route validates by magic bytes and rejects anything outside the image /
 * text / PDF set, so nothing is pre-filtered here beyond what the browser
 * already handed over — a client-side allowlist would only disagree with the
 * server's and produce two different refusal messages for one file.
 */

import type { ChatAttachment, UploadChatAttachmentResponse } from '@mangostudio/shared/chat';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function uploadChatAttachment(chatId: string, file: File): Promise<ChatAttachment> {
  const { data, error } = await client.api.upload.chat.post({ chatId, file });
  if (error) throw new ApiError(error.value);
  return (data as UploadChatAttachmentResponse).attachment;
}
