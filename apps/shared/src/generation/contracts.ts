import type { Message } from '../chat/entities';

/** A persisted message returned by the generate or respond endpoint. */
export interface GeneratedMessage extends Message {
  isGenerating: boolean;
}

/** Response for POST /api/generate — returns both persisted messages. */
export interface GenerateImageResponse {
  userMessage: GeneratedMessage;
  aiMessage: GeneratedMessage;
}

/** Response for POST /api/respond — returns both persisted messages. */
export interface GenerateTextResponse {
  userMessage: GeneratedMessage;
  aiMessage: GeneratedMessage;
}
