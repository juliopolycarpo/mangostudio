# Attachments

O MangoStudio suporta upload de arquivos como attachments de chat e sua entrega aos provedores de IA durante a geração.

## Tipos De Arquivo Suportados

| Tipo       | Extensões                             | Tamanho máximo |
| ---------- | ------------------------------------- | -------------- |
| **Imagem** | JPEG, PNG, GIF, WebP, AVIF, HEIC/HEIF | 20 MB          |
| **PDF**    | PDF                                   | 20 MB          |
| **Texto**  | Texto plano, Markdown, CSV, JSON      | 20 MB          |

## Fluxo De Upload

```
Browser (input de arquivo)
    │
    ▼
POST /api/upload
    ├─ verificação de auth (requireAuth)
    ├─ validação do arquivo (attachment-validation.ts)
    │   ├─ detecção de MIME (biblioteca file-type)
    │   ├─ verificação de magic bytes
    │   ├─ checagem de consistência extensão/MIME
    │   ├─ validação de tamanho (≤ 20 MB)
    │   └─ validação de UTF-8 (para arquivos de texto)
    │
    ▼
Storage (attachment-storage.ts)
    ├─ sanitiza nome do arquivo (normalização NFKD, proteção contra path traversal)
    ├─ monta path: {uploadsDir}/{chatTitle}_{chatId}/{date}/{id}-{name}.{ext}
    └─ Bun.write() em disco
        │
        ▼
Repository (attachment-repository.ts)
    └─ insertChatAttachment() → linha na tabela chat_attachments
```

## Detalhes De Validação

`validateChatAttachmentFile()` em `attachment-validation.ts`:

1. **Checagem de vazio** — Rejeita arquivos com zero bytes.
2. **Checagem de tamanho** — Rejeita arquivos maiores que 20 MB (`CHAT_ATTACHMENT_MAX_SIZE_BYTES`).
3. **Detecção de tipo** — Usa `file-type` para detectar MIME a partir dos magic bytes.
4. **Classificação do tipo** — Mapeia para `image`, `pdf` ou `text`.
5. **Validação da extensão** — Confirma que a extensão do arquivo corresponde ao tipo detectado.
6. **Checagem de UTF-8** — Para arquivos de texto, verifica ausência de bytes nulos e encoding UTF-8 válido.

## Sanitização De Paths

`buildAttachmentStoragePath()` constrói paths de arquivo determinísticos e seguros:

```
{uploadsDir}/{sanitizedChatTitle}_{chatId}/{uploadedAt}/{attachmentId}-{safeOriginalName}.{ext}
```

`sanitizePathSegment()` aplica:

- normalização Unicode NFKD, removendo diacríticos
- substituição de bytes nulos, barras invertidas e separadores de path
- colapso de espaços em branco e hífens
- trim de separadores no início e no fim
- truncamento para 80 caracteres

## Vinculação Ao Turno

Attachments são associados a mensagens de chat via o método de repositório `linkAttachmentsToMessage()`:

1. O upload cria uma linha com `messageId: null`.
2. Quando uma mensagem é enviada, `linkAttachmentsToMessage()` atribui o ID da mensagem.
3. Re-vincular ao mesmo `messageId` é idempotente e vira no-op.
4. Re-vincular a outra mensagem não é permitido, porque o attachment já foi consumido.

## Entrega Ao Provedor

No momento da geração, `resolveProviderRuntimeAttachments()` em `runtime-attachment-resolver.ts`:

1. Valida que todos os IDs de attachment existem e pertencem ao usuário/chat.
2. Lê os bytes do arquivo em disco com `Bun.file()`.
3. Retorna `ProviderRuntimeAttachment[]` com `id`, `originalName`, `mimeType`, `sizeBytes`, `kind` e `bytes`.

### Suporte Por Provedor

`isAttachmentSupportedByProvider()` em `attachment-content.ts` consulta `ModelCapabilities`:

- **Attachments de imagem** — suportados se `imageInput: true`.
- **Attachments PDF** — suportados se `pdfInput: true`.
- **Attachments de texto** — suportados se `textFileInput: true`.

### Notas De Fallback

Quando um modelo não suporta um determinado tipo de attachment, `appendAttachmentFallbackNotes()` adiciona uma nota descritiva ao prompt do usuário:

```
[Attachment report.pdf was not sent because this model does not support PDF attachments.]
```

Isso garante que o modelo saiba da existência do attachment mesmo quando não consegue processar seu conteúdo.

## Schema Do Banco De Dados

Tabela `chat_attachments`:

| Coluna         | Tipo            | Finalidade               |
| -------------- | --------------- | ------------------------ |
| `id`           | text (PK)       | ID do attachment         |
| `userId`       | text            | Dono                     |
| `chatId`       | text            | Chat pai                 |
| `messageId`    | text (nullable) | Mensagem vinculada       |
| `originalName` | text            | Nome original do arquivo |
| `path`         | text            | Path de storage          |
| `mimeType`     | text            | MIME detectado           |
| `sizeBytes`    | integer         | Tamanho do arquivo       |
| `kind`         | text            | `image` / `pdf` / `text` |
| `uploadedAt`   | text            | Timestamp ISO            |
| `createdAt`    | text            | Timestamp ISO            |

## Frontend

Attachments são renderizados no feed de chat via `MessageParts.tsx`. Imagens enviadas aparecem como thumbnails; outros arquivos aparecem como cards com ícone + nome do arquivo. A barra de input suporta seleção de arquivos e mostra attachments pendentes antes do envio.
