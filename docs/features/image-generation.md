# Image Generation

MangoStudio supports image generation through two paths: the `generate_image` tool (called by models during text chats) and direct generation from the UI.

## Architecture

```
Frontend (GalleryPage, useImageGeneration)
    │
    ▼
API Routes
    ├─ POST /generate-image        → Direct image generation
    ├─ GET  /images/:filename      → Serve generated images
    └─ During chat turns           → generate_image tool execution
         │
         ▼
Generation Service (generate-image.ts)
    ├─ Model resolution (type: 'image')
    ├─ Provider image generation
    │
    ▼
Storage (generated-image-storage.ts)
    ├─ File writing to images/ directory
    └─ URL path generation
         │
         ▼
Repository (generated-image-repository.ts)
    ├─ Insert artifact row
    ├─ Query by message IDs
    └─ Gallery pagination
```

## Image Generation Flows

### 1. Tool-based Generation (during chat)

When the `generate_image` tool is invoked during a text chat turn:

1. **Tool detection** — `stream-text-turn.ts` detects the `generate_image` tool call.
2. **Standard tools first** — Non-image tools execute in parallel via `Promise.all`.
3. **Image planning** — `createGenerateImageToolPlan()` parses the LLM's arguments (prompt, count, quality, model) and user settings.
4. **Per-image streaming** — `generateImagesForToolPlan()` yields per-image outcomes:
   - `image_generation_started` SSE event for each planned image.
   - `image_generation_completed` on success (with URL and metadata).
   - `image_generation_failed` on failure (with error details).
5. **Result summarization** — `summarizeGenerateImageToolResult()` collapses outcomes into a single tool result fed back to the model.
6. **Persistence** — `insertGeneratedImageArtifact()` stores each image's metadata in the `generated_images` table.
7. **UI rendering** — The `GeneratedImagePart` component in the chat feed renders completed images.

### 2. Direct Generation (UI-initiated)

When the user clicks "Generate Image" directly:

1. **Route** — `POST /api/generate-image` with prompt, quality, model, and optional reference image.
2. **Prompt composition** — System prompt rules are applied via `prompt-composer.ts`.
3. **Provider call** — `provider.generateImage()` handles the provider-specific API.
4. **Turn persistence** — `persistImageTurn()` creates user message + AI response + image artifacts in one transaction.
5. **Response** — Returns `GenerateImageResult` with both messages for immediate rendering.

## Model Selection

Image-capable models are identified via the `ModelInfo` catalog:

- **Gemini** — `gemini-2.0-flash-exp-image-generation`, `imagen-4.0-generate-001`
- **OpenAI** — `dall-e-3`, `dall-e-3-hd`
- **OpenAI-compatible** — Models with `imageGeneration: true` capability flag

The image model selector (`feat/tools-image-model-selector`) uses a catalog-backed dropdown that shows only image-capable models from all connected providers.

## Generated Image Storage

Images are stored on the filesystem under the configured `images.dir` directory (defaults to `~/.mango/images/`).

**File naming:** `{prefix}-{timestamp}-{uuid}.{ext}`

**Supported formats:** AVIF, GIF, JPEG, PNG, WebP

**URL access:** Images are served via `GET /images/:filename`. The API maps this route to serve static files from the images directory.

## Gallery

The gallery (`apps/frontend/src/features/gallery/GalleryPage.tsx`) provides:

- **Infinite scroll** — Cursor-based pagination with `IntersectionObserver`.
- **Responsive grid** — 1–4 columns based on viewport width.
- **Image cards** — Lazy-loaded images with gradient overlay on hover showing the prompt.
- **Modal view** — Click to enlarge with download option.
- **Filtering** — Queries by user ID, ordered by creation date descending.

### Gallery Query

```typescript
listGeneratedImagesForGallery(userId, { cursor, limit });
// Returns: { items: GalleryItem[], nextCursor?: string }
```

## Generated Images vs Uploads

| Aspect                  | Generated Images     | Uploads (Attachments) |
| ----------------------- | -------------------- | --------------------- |
| **Origin**              | Created by AI models | Uploaded by users     |
| **Storage path**        | `images.dir/`        | `uploads.dir/`        |
| **DB table**            | `generated_images`   | `chat_attachments`    |
| **URL prefix**          | `/images/`           | `/uploads/`           |
| **Gallery**             | Yes                  | No                    |
| **Attachment delivery** | No                   | Yes                   |
