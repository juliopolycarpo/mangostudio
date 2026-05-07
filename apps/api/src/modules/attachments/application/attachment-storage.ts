import { join, parse } from 'path';
import { mkdirSync } from 'fs';
import { getConfig } from '../../../lib/config';

const FALLBACK_CHAT_TITLE = 'chat';
const FALLBACK_FILE_BASENAME = 'attachment';
const MAX_SAFE_SEGMENT_LENGTH = 80;

export interface AttachmentStoragePathInput {
  chatId: string;
  chatTitle: string;
  attachmentId: string;
  originalName: string;
  extension: string;
  uploadedAt: number;
}

export interface AttachmentStoragePath {
  storedName: string;
  relativePath: string;
  absolutePath: string;
  url: string;
}

export function buildAttachmentStoragePath(
  input: AttachmentStoragePathInput
): AttachmentStoragePath {
  const uploadsDir = getConfig().uploads.dir;
  const safeChatTitle = sanitizePathSegment(input.chatTitle) || FALLBACK_CHAT_TITLE;
  const safeChatId =
    sanitizePathSegment(input.chatId) || input.chatId.replace(/[^A-Za-z0-9_-]/g, '');
  const safeOriginalBase =
    sanitizePathSegment(parse(input.originalName).name) || FALLBACK_FILE_BASENAME;
  const safeExtension = sanitizePathSegment(input.extension).replace(/\./g, '') || 'bin';
  const storedName = `${input.attachmentId}-${safeOriginalBase}.${safeExtension}`;
  const chatDirectory = `${safeChatTitle}_${safeChatId}`;
  const relativePath = `${chatDirectory}/${input.uploadedAt}/${storedName}`;
  const absolutePath = join(uploadsDir, chatDirectory, String(input.uploadedAt), storedName);

  return {
    storedName,
    relativePath,
    absolutePath,
    url: `/uploads/${relativePath}`,
  };
}

export async function writeAttachmentFile(path: string, buffer: ArrayBuffer): Promise<void> {
  mkdirSync(parse(path).dir, { recursive: true });
  await Bun.write(path, buffer);
}

export function sanitizePathSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/\0]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, MAX_SAFE_SEGMENT_LENGTH);
}
