import type {
  ChatRunnerConfiguration,
  ContextCompactionResponse,
  ContextInfo,
} from '@mangostudio/shared/chat';
import type { MessagePart, ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  buildPersistedContextSnapshot,
  computeContextSnapshot,
} from '../../../services/providers/core/context-policy';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { generateId } from '../../../utils/id';
import { resolveModel } from '../../generation/application/resolve-model';
import {
  persistAiResponse,
  updateChatAfterTurn,
} from '../../generation/infrastructure/conversation-persistence';
import { loadHistory } from '../../messages/infrastructure/message-repository';
import { ChatNotFoundError } from '../domain/chat-ownership';
import { createChat, getById, updateChat } from '../infrastructure/chat-repository';

const SUMMARY_SYSTEM_PROMPT =
  'Summarize the conversation for context compaction. Keep facts, goals, constraints, decisions, and open questions. Be concise and faithful. Do not mention the act of summarizing.';

export class EmptyChatCompactionError extends Error {
  constructor(chatId: string) {
    super(`Chat "${chatId}" has no chat history to summarize.`);
    this.name = 'EmptyChatCompactionError';
  }
}

export interface CompactChatInput {
  chatId: string;
  userId: string;
  model?: string;
}

interface OwnedChat {
  id: string;
  title: string;
  model: string | null;
  textModel: string | null;
  imageModel: string | null;
  environmentId: string;
  runner: ChatRunnerConfiguration;
  workdir: string | null;
  restrictToolsToWorkdir: boolean | null;
}

function buildSummaryParts(
  event: 'chat_compacted' | 'summary_handoff',
  summary: string
): MessagePart[] {
  return [
    { type: 'system_event', event },
    { type: 'text', text: summary },
  ];
}

function toContextInfo(snapshot: ReturnType<typeof buildPersistedContextSnapshot>): ContextInfo {
  return {
    estimatedInputTokens: snapshot.estimatedInputTokens,
    contextLimit: snapshot.contextLimit,
    estimatedUsageRatio: snapshot.estimatedUsageRatio,
    mode: snapshot.mode,
    severity: snapshot.severity,
  };
}

async function loadOwnedChat(
  chatId: string,
  userId: string,
  db: Kysely<Database>
): Promise<OwnedChat> {
  const chat = await getById(chatId, db);
  if (!chat || chat.userId !== userId) throw new ChatNotFoundError(chatId);

  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    textModel: chat.textModel,
    imageModel: chat.imageModel,
    environmentId: chat.environmentId,
    runner: chat.runner,
    workdir: chat.workdir,
    restrictToolsToWorkdir: chat.restrictToolsToWorkdir,
  };
}

function formatSummaryPrompt(history: Awaited<ReturnType<typeof loadHistory>>): string {
  return history
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
}

async function generateSummary(params: {
  modelName: string;
  providerType?: ProviderType;
  userId: string;
  chatId: string;
  environmentId: string;
  db: Kysely<Database>;
}): Promise<string> {
  const history = await loadHistory(params.chatId, {}, params.db);
  if (history.length === 0) throw new EmptyChatCompactionError(params.chatId);

  const provider = params.providerType
    ? getProvider(params.providerType)
    : await getProviderForModel(params.modelName, params.userId);
  const result = await provider.generateText({
    userId: params.userId,
    environmentId: params.environmentId,
    chatId: params.chatId,
    history: [],
    prompt: formatSummaryPrompt(history),
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    modelName: params.modelName,
    generationConfig: {
      thinkingEnabled: false,
      reasoningEffort: 'medium',
      enableProviderCompaction: false,
    },
  });

  return result.text.trim();
}

async function persistSummaryMessage(params: {
  chatId: string;
  modelName: string;
  summary: string;
  event: 'chat_compacted' | 'summary_handoff';
  db: Kysely<Database>;
}): Promise<{ summaryMessageId: string; contextInfo: ContextInfo }> {
  const summaryMessageId = generateId();
  const timestamp = Date.now();
  const parts = buildSummaryParts(params.event, params.summary);
  const snapshot = buildPersistedContextSnapshot(
    computeContextSnapshot({
      modelName: params.modelName,
      history: [{ id: summaryMessageId, role: 'ai', text: params.summary, parts }],
      mode: 'compacted',
    })
  );

  await persistAiResponse(
    {
      id: summaryMessageId,
      chatId: params.chatId,
      text: params.summary,
      parts,
      providerState: null,
      timestamp,
      generationTime: '0.0s',
      modelName: params.modelName,
    },
    params.db
  );

  await params.db
    .updateTable('chats')
    .set({
      lastProviderState: null,
      lastContextState: JSON.stringify(snapshot),
    })
    .where('id', '=', params.chatId)
    .execute();
  await updateChatAfterTurn(params.chatId, timestamp, params.db);

  return { summaryMessageId, contextInfo: toContextInfo(snapshot) };
}

export async function compactChatUseCase(
  input: CompactChatInput,
  db: Kysely<Database>
): Promise<ContextCompactionResponse> {
  const chat = await loadOwnedChat(input.chatId, input.userId, db);
  const resolvedModel = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });
  const summary = await generateSummary({
    modelName: resolvedModel.modelId,
    providerType: resolvedModel.providerType,
    userId: input.userId,
    chatId: input.chatId,
    environmentId: chat.environmentId,
    db,
  });
  const result = await persistSummaryMessage({
    chatId: input.chatId,
    modelName: resolvedModel.modelId,
    summary,
    event: 'chat_compacted',
    db,
  });

  return { chatId: input.chatId, ...result };
}

export async function summarizeToNewChatUseCase(
  input: CompactChatInput,
  db: Kysely<Database>
): Promise<ContextCompactionResponse> {
  const sourceChat = await loadOwnedChat(input.chatId, input.userId, db);
  const resolvedModel = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });
  const summary = await generateSummary({
    modelName: resolvedModel.modelId,
    providerType: resolvedModel.providerType,
    userId: input.userId,
    chatId: input.chatId,
    environmentId: sourceChat.environmentId,
    db,
  });
  const nextChat = await createChat(
    {
      title: sourceChat.title,
      model: sourceChat.model,
      userId: input.userId,
      environmentId: sourceChat.environmentId,
    },
    db
  );

  await updateChat(
    nextChat.id,
    input.userId,
    {
      textModel: sourceChat.textModel ?? undefined,
      imageModel: sourceChat.imageModel ?? undefined,
      runner: sourceChat.runner,
      workdir: sourceChat.workdir,
      restrictToolsToWorkdir: sourceChat.restrictToolsToWorkdir,
    },
    db
  );

  const result = await persistSummaryMessage({
    chatId: nextChat.id,
    modelName: resolvedModel.modelId,
    summary,
    event: 'summary_handoff',
    db,
  });

  return { chatId: nextChat.id, ...result };
}
