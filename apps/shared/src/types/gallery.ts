/** Persisted generated image metadata shared by API and frontend. */
export interface GeneratedImageArtifact {
  id: string;
  chatId: string;
  messageId: string;
  prompt: string;
  imageUrl: string;
  createdAt: number;
  toolCallId?: string;
  modelName?: string;
  generationTime?: string;
  metadata?: Record<string, unknown>;
}

/** Gallery item used for displaying generated images across chats. */
export type GalleryItem = GeneratedImageArtifact;
