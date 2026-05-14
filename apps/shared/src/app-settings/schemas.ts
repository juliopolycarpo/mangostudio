import { Type, type Static } from '@sinclair/typebox';
import { CHAT_TITLE_PROMPT_LENGTH_MAX, CHAT_TITLE_PROMPT_LENGTH_MIN } from '../chat/title';
import { ContextSettingsSchema } from '../chat';
import { PromptSettingsSchema } from '../prompt-rules';
import { ReasoningEffortSchema } from '../provider-settings';

export const ImageQualitySchema = Type.Union([
  Type.Literal('512px'),
  Type.Literal('1K'),
  Type.Literal('2K'),
  Type.Literal('4K'),
]);

export const ChatTitleSettingsSchema = Type.Object({
  autoRenameEnabled: Type.Boolean(),
  strategy: Type.Union([Type.Literal('prompt_prefix'), Type.Literal('model')]),
  promptPrefixLength: Type.Integer({
    minimum: CHAT_TITLE_PROMPT_LENGTH_MIN,
    maximum: CHAT_TITLE_PROMPT_LENGTH_MAX,
  }),
  preferredModel: Type.String(),
});

export const MultiAgentSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  chatDelegationEnabled: Type.Boolean(),
  traceVisibility: Type.Union([Type.Literal('compact'), Type.Literal('full'), Type.Literal('off')]),
  maxDepth: Type.Integer({ minimum: 0, maximum: 3 }),
  maxSubagentCalls: Type.Integer({ minimum: 0, maximum: 10 }),
  timeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
  defaultMaxTurns: Type.Integer({ minimum: 1, maximum: 10 }),
});

export const AppSettingsSchema = Type.Object({
  promptSettings: PromptSettingsSchema,
  globalImageQuality: ImageQualitySchema,
  thinkingEnabled: Type.Boolean(),
  reasoningEffort: ReasoningEffortSchema,
  maxToolIterations: Type.Integer({ minimum: 1, maximum: 25 }),
  multiAgentSettings: MultiAgentSettingsSchema,
  contextSettings: ContextSettingsSchema,
  chatTitleSettings: ChatTitleSettingsSchema,
});

export type ImageQuality = Static<typeof ImageQualitySchema>;
export type ChatTitleSettings = Static<typeof ChatTitleSettingsSchema>;
export type ChatTitleStrategy = ChatTitleSettings['strategy'];
export type MultiAgentSettings = Static<typeof MultiAgentSettingsSchema>;
export type AppSettings = Static<typeof AppSettingsSchema>;
