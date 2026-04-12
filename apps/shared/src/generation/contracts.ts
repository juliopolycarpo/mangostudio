import type { InteractionMode, MessagePart } from '../types/index';

/** A persisted message returned by the generate or respond endpoint. */
export interface GeneratedMessage {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string;
  referenceImage?: string;
  timestamp: number;
  isGenerating: boolean;
  generationTime?: string;
  modelName?: string;
  styleParams?: string[];
  interactionMode?: InteractionMode;
  parts?: MessagePart[];
  providerState?: string;
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
