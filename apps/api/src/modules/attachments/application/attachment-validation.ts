import type { ChatAttachmentKind } from '@mangostudio/shared/chat';
import { fileTypeFromBuffer } from 'file-type';
import { extname } from 'path';

const IMAGE_MIME_EXTENSIONS = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'image/heic': ['heic', 'heif'],
  'image/heif': ['heic', 'heif'],
} as const;

const TEXT_MIME_EXTENSIONS = {
  'text/plain': ['txt'],
  'text/markdown': ['md', 'markdown'],
  'text/csv': ['csv'],
  'application/json': ['json'],
} as const;

const PDF_MIME = 'application/pdf';
const PDF_EXTENSIONS = ['pdf'];

export const CHAT_ATTACHMENT_MAX_SIZE = '20m';
export const CHAT_ATTACHMENT_MAX_SIZE_BYTES = 20 * 1024 * 1024;

export class InvalidAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttachmentError';
  }
}

export interface ValidatedAttachmentFile {
  buffer: ArrayBuffer;
  mimeType: string;
  extension: string;
  kind: ChatAttachmentKind;
  sizeBytes: number;
}

type SupportedMime =
  | keyof typeof IMAGE_MIME_EXTENSIONS
  | keyof typeof TEXT_MIME_EXTENSIONS
  | typeof PDF_MIME;

export async function validateChatAttachmentFile(file: File): Promise<ValidatedAttachmentFile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength === 0) {
    throw new InvalidAttachmentError('Attachment file cannot be empty.');
  }

  if (bytes.byteLength > CHAT_ATTACHMENT_MAX_SIZE_BYTES) {
    throw new InvalidAttachmentError('Attachment file exceeds the 20 MB limit.');
  }

  const originalExtension = getLowercaseExtension(file.name);
  const detectedType = await fileTypeFromBuffer(buffer);

  if (detectedType?.mime && isImageMime(detectedType.mime)) {
    assertExtensionAllowed(detectedType.mime, originalExtension);
    return {
      buffer,
      mimeType: detectedType.mime,
      extension: preferredExtension(detectedType.mime),
      kind: 'image',
      sizeBytes: bytes.byteLength,
    };
  }

  if (isPdf(bytes, detectedType?.mime)) {
    assertExtensionAllowed(PDF_MIME, originalExtension);
    return {
      buffer,
      mimeType: PDF_MIME,
      extension: 'pdf',
      kind: 'pdf',
      sizeBytes: bytes.byteLength,
    };
  }

  const textMimeType = normalizeTextMime(file.type, originalExtension);
  if (textMimeType) {
    assertUtf8Text(bytes);
    assertExtensionAllowed(textMimeType, originalExtension);
    return {
      buffer,
      mimeType: textMimeType,
      extension: preferredExtension(textMimeType),
      kind: 'text',
      sizeBytes: bytes.byteLength,
    };
  }

  throw new InvalidAttachmentError('Unsupported attachment file type.');
}

function getLowercaseExtension(name: string): string {
  return extname(name).replace(/^\./, '').toLowerCase();
}

function isImageMime(mime: string): mime is keyof typeof IMAGE_MIME_EXTENSIONS {
  return mime in IMAGE_MIME_EXTENSIONS;
}

function isPdf(bytes: Uint8Array, detectedMime: string | undefined): boolean {
  if (detectedMime === PDF_MIME) return true;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function normalizeTextMime(
  mimeType: string,
  extension: string
): keyof typeof TEXT_MIME_EXTENSIONS | null {
  if (mimeType in TEXT_MIME_EXTENSIONS) return mimeType as keyof typeof TEXT_MIME_EXTENSIONS;

  for (const [mime, extensions] of Object.entries(TEXT_MIME_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(extension)) {
      return mime as keyof typeof TEXT_MIME_EXTENSIONS;
    }
  }

  return null;
}

function assertUtf8Text(bytes: Uint8Array): void {
  if (bytes.includes(0)) {
    throw new InvalidAttachmentError('Text attachments cannot contain null bytes.');
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidAttachmentError('Text attachments must be valid UTF-8.');
  }
}

function assertExtensionAllowed(mime: SupportedMime, extension: string): void {
  const allowedExtensions = getAllowedExtensions(mime);
  if (!extension || !allowedExtensions.includes(extension)) {
    throw new InvalidAttachmentError(
      `File extension does not match detected type ${mime}. Expected: ${allowedExtensions.join(', ')}.`
    );
  }
}

function preferredExtension(mime: SupportedMime): string {
  return getAllowedExtensions(mime)[0];
}

function getAllowedExtensions(mime: SupportedMime): readonly string[] {
  if (mime === PDF_MIME) return PDF_EXTENSIONS;
  if (mime in IMAGE_MIME_EXTENSIONS)
    return IMAGE_MIME_EXTENSIONS[mime as keyof typeof IMAGE_MIME_EXTENSIONS];
  return TEXT_MIME_EXTENSIONS[mime as keyof typeof TEXT_MIME_EXTENSIONS];
}
