import type { GeneratedImageArtifact } from '../chat/schemas';

/** Persisted generated image metadata shared by API and frontend; the schema in `chat/schemas.ts` is its source of truth. */
export type { GeneratedImageArtifact };

/** Gallery item used for displaying generated images across chats. */
export type GalleryItem = GeneratedImageArtifact;
