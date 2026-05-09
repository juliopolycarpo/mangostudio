# Attachments

MangoStudio supports uploading files as chat attachments and delivering them to AI providers during generation.

## Supported File Types

| Kind      | Extensions                            | Max Size |
| --------- | ------------------------------------- | -------- |
| **Image** | JPEG, PNG, GIF, WebP, AVIF, HEIC/HEIF | 20 MB    |
| **PDF**   | PDF                                   | 20 MB    |
| **Text**  | Plain text, Markdown, CSV, JSON       | 20 MB    |

## Upload Flow

```
Browser (file input)
    │
    ▼
POST /api/upload
    ├─ Auth check (requireAuth)
    ├─ File validation (attachment-validation.ts)
    │   ├─ MIME detection (file-type library)
    │   ├─ Magic byte verification
    │   ├─ Extension/MIME consistency check
    │   ├─ Size validation (≤ 20 MB)
    │   └─ UTF-8 validation (for text files)
    │
    ▼
Storage (attachment-storage.ts)
    ├─ Sanitize filename (NFKD normalization, path traversal protection)
    ├─ Build path: {uploadsDir}/{chatTitle}_{chatId}/{date}/{id}-{name}.{ext}
    └─ Bun.write() to disk
        │
        ▼
Repository (attachment-repository.ts)
    └─ insertChatAttachment() → row in chat_attachments table
```

## Validation Details

`validateChatAttachmentFile()` in `attachment-validation.ts`:

1. **Empty check** — Rejects zero-byte files.
2. **Size check** — Rejects files over 20 MB (`CHAT_ATTACHMENT_MAX_SIZE_BYTES`).
3. **Type detection** — Uses `file-type` to detect MIME from magic bytes.
4. **Kind classification** — Maps to `image`, `pdf`, or `text` kind.
5. **Extension assertion** — Validates the file extension matches the detected kind.
6. **UTF-8 check** — For text files, verifies no null bytes and valid UTF-8 encoding.

## Path Sanitization

`buildAttachmentStoragePath()` constructs deterministic, safe file paths:

```
{uploadsDir}/{sanitizedChatTitle}_{chatId}/{uploadedAt}/{attachmentId}-{safeOriginalName}.{ext}
```

`sanitizePathSegment()` applies:

- NFKD Unicode normalization (strips diacritics)
- Replaces null bytes, backslashes, and path separators
- Collapses whitespace and hyphens
- Trims leading/trailing separators
- Truncates to 80 characters

## Turn Linking

Attachments are associated with chat messages via the `linkAttachmentsToMessage()` repository method:

1. Upload creates a row with `messageId: null`.
2. When a message is sent, `linkAttachmentsToMessage()` assigns the message ID.
3. Re-linking is idempotent — linking to the same message is a no-op.
4. Re-linking to a different message is not allowed (attachment is consumed).

## Provider Delivery

At generation time, `resolveProviderRuntimeAttachments()` in `runtime-attachment-resolver.ts`:

1. Validates all attachment IDs exist and belong to the user/chat.
2. Reads file bytes from disk via `Bun.file()`.
3. Returns `ProviderRuntimeAttachment[]` with `id`, `originalName`, `mimeType`, `sizeBytes`, `kind`, and `bytes`.

### Provider Support

`isAttachmentSupportedByProvider()` in `attachment-content.ts` checks `ModelCapabilities`:

- **Image attachments** — Supported if `imageInput: true`.
- **PDF attachments** — Supported if `pdfInput: true`.
- **Text file attachments** — Supported if `textFileInput: true`.

### Fallback Notes

When a model does not support a given attachment type, `appendAttachmentFallbackNotes()` adds a descriptive note to the user prompt:

```
[Attachment report.pdf was not sent because this model does not support PDF attachments.]
```

This ensures the model is aware of the attachment's presence even if it cannot process the content.

## Database Schema

`chat_attachments` table:

| Column         | Type            | Purpose                  |
| -------------- | --------------- | ------------------------ |
| `id`           | text (PK)       | Attachment ID            |
| `userId`       | text            | Owner                    |
| `chatId`       | text            | Parent chat              |
| `messageId`    | text (nullable) | Linked message           |
| `originalName` | text            | Original filename        |
| `path`         | text            | Storage path             |
| `mimeType`     | text            | Detected MIME            |
| `sizeBytes`    | integer         | File size                |
| `kind`         | text            | `image` / `pdf` / `text` |
| `uploadedAt`   | text            | ISO timestamp            |
| `createdAt`    | text            | ISO timestamp            |

## Frontend

Attachments are rendered in the chat feed via `MessageParts.tsx`. Uploaded images display as thumbnails, other files show as icon + filename cards. The input bar supports file selection and displays pending attachments before sending.
