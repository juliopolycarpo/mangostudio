import { type Static, Type } from '@sinclair/typebox';
import {
  MAX_SUBAGENT_CALLS_MAX,
  MAX_SUBAGENT_CALLS_MIN,
  MAX_TOOL_ITERATIONS_MAX,
  MAX_TOOL_ITERATIONS_MIN,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
} from '../agentic-limits';
import { ContextSettingsSchema } from '../chat';
import { CHAT_TITLE_PROMPT_LENGTH_MAX, CHAT_TITLE_PROMPT_LENGTH_MIN } from '../chat/title';
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
  maxSubagentCalls: Type.Integer({
    minimum: MAX_SUBAGENT_CALLS_MIN,
    maximum: MAX_SUBAGENT_CALLS_MAX,
  }),
  timeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
  defaultMaxTurns: Type.Integer({
    minimum: SUBAGENT_MAX_TURNS_MIN,
    maximum: SUBAGENT_MAX_TURNS_MAX,
  }),
});

/**
 * Opt-in toggles for the third-party skill source directories. The native
 * `~/.mango/skills` source is always on; `~/.agents/skills` and
 * `~/.claude/skills` are off by default because they were authored for other
 * agents and may not suit MangoStudio.
 */
export const SkillSourcesSettingsSchema = Type.Object({
  agents: Type.Boolean(),
  claude: Type.Boolean(),
});

export const AppSettingsSchema = Type.Object({
  promptSettings: PromptSettingsSchema,
  globalImageQuality: ImageQualitySchema,
  thinkingEnabled: Type.Boolean(),
  reasoningEffort: ReasoningEffortSchema,
  maxToolIterations: Type.Integer({
    minimum: MAX_TOOL_ITERATIONS_MIN,
    maximum: MAX_TOOL_ITERATIONS_MAX,
  }),
  multiAgentSettings: MultiAgentSettingsSchema,
  contextSettings: ContextSettingsSchema,
  chatTitleSettings: ChatTitleSettingsSchema,
  skillSources: SkillSourcesSettingsSchema,
});

export type ImageQuality = Static<typeof ImageQualitySchema>;
export type ChatTitleSettings = Static<typeof ChatTitleSettingsSchema>;
export type ChatTitleStrategy = ChatTitleSettings['strategy'];
export type MultiAgentSettings = Static<typeof MultiAgentSettingsSchema>;
export type SkillSourcesSettings = Static<typeof SkillSourcesSettingsSchema>;
export type AppSettings = Static<typeof AppSettingsSchema>;
