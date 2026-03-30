/**
 * Raw database row types for the MangoStudio SQLite schema.
 * These mirror the exact column types stored in the database and
 * must NOT be exported to the frontend — use the domain types in
 * @mangostudio/shared instead.
 */

/** Raw row returned by SELECT * FROM chats. */
export interface ChatRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  lastUsedMode: string | null;
  userId: string | null;
}

/** Raw row returned by SELECT * FROM messages. */
export interface MessageRow {
  id: string;
  chatId: string;
  role: string;
  text: string;
  imageUrl: string | null;
  referenceImage: string | null;
  timestamp: number;
  /** SQLite stores booleans as integers: 0 = false, 1 = true. */
  isGenerating: number;
  generationTime: string | null;
  modelName: string | null;
  /** JSON-serialised string[]. */
  styleParams: string | null;
  interactionMode: string;
}
