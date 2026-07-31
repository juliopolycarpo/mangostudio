import type { MessagePart } from '../types/agent-events';
import type { GeneratedImageArtifact } from '../types/gallery';
import type { InteractionMode } from '../types/provider';
import type { ChatAttachment } from './schemas';

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
