import type { InteractionMode } from '../types/provider';
import type { MessagePart } from '../types/agent-events';

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
  timestamp: Date;
  styleParams?: string[];
  generationTime?: string;
  isGenerating?: boolean;
  modelName?: string;
  parts?: MessagePart[];
  providerState?: string;
}
