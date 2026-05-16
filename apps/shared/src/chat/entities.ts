import type { MessagePart } from '../types/agent-events';
import type { GeneratedImageArtifact } from '../types/gallery';
import type { InteractionMode } from '../types/provider';

export type ChatAttachmentKind = 'image' | 'text' | 'pdf' | 'data' | 'unknown';

export interface ChatAttachment {
  id: string;
  chatId: string;
  messageId?: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  url: string;
  createdAt: number;
}

/** Represents a chat session. */
export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** @deprecated Use textModel or imageModel instead. */
  model?: string;
  textModel?: string;
  imageModel?: string;
  lastUsedMode?: InteractionMode;
  selectedAgentId?: string | null;
}

/** Represents a message within a chat. */
export interface Message {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  interactionMode?: InteractionMode;
  imageUrl?: string;
  referenceImage?: string;
  timestamp: number;
  styleParams?: string[];
  generationTime?: string;
  isGenerating?: boolean;
  modelName?: string;
  agentId?: string;
  agentName?: string;
  parts?: MessagePart[];
  providerState?: string;
  generatedImages?: GeneratedImageArtifact[];
  attachments?: ChatAttachment[];
}
