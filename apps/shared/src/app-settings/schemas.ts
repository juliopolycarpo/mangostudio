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
import { ExternalAgentSettingsSchema } from '../external-agents/disclosure';
import {
  COMMIT_MESSAGE_MAX_DIFF_KB_MAX,
  COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
} from '../git/commit-message';
import { LibraryLocationIdSchema, LibraryScopeSchema } from '../library';
import { ProfileIdSchema } from '../profiles';
import { PromptSettingsSchema } from '../prompt-rules';
import { ReasoningEffortSchema } from '../provider-settings';
import { WorkspaceSettingsSchema } from '../workspaces';

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

/** Enablement map for the code-defined locations the library scanner may read. */
const LibraryLocationTogglesSchema = Type.Record(LibraryLocationIdSchema, Type.Boolean());

/**
 * Per-scope enablement. Nested rather than flat because a flat map cannot say
 * "workspace skills on, home skills off" without forking the location id space,
 * and the id space is the one thing scope must stay orthogonal to.
 *
 * `workspace` is present and empty in v1: no location resolves under it yet.
 */
export const LibraryLocationSettingsSchema = Type.Record(
  LibraryScopeSchema,
  LibraryLocationTogglesSchema
);

/** PUT bodies may predate the workspace scope or use a flat home map; normalize before persisting. */
const LibraryLocationSettingsPutSchema = Type.Union([
  LibraryLocationSettingsSchema,
  Type.Object({
    home: LibraryLocationTogglesSchema,
    workspace: Type.Optional(LibraryLocationTogglesSchema),
  }),
  LibraryLocationTogglesSchema,
]);

/**
 * Per-profile settings overlay. Named `profileSettings` rather than `profiles`
 * because it holds settings scoped *by* profile, not profile definitions —
 * there is no profile entity yet.
 */
export const ProfileScopedSettingsSchema = Type.Object({
  libraryLocations: LibraryLocationSettingsSchema,
});

const ProfileScopedSettingsPutSchema = Type.Object({
  libraryLocations: LibraryLocationSettingsPutSchema,
});

export const ProfileSettingsMapSchema = Type.Record(ProfileIdSchema, ProfileScopedSettingsSchema);

const ProfileSettingsMapPutSchema = Type.Record(ProfileIdSchema, ProfileScopedSettingsPutSchema);

export const DiffPreviewModeSchema = Type.Union([
  Type.Literal('expanded'),
  Type.Literal('collapsed'),
  Type.Literal('collapse_older'),
]);

export const ChatDisplaySettingsSchema = Type.Object({
  diffPreviewsEnabled: Type.Boolean(),
  diffPreviewMode: DiffPreviewModeSchema,
});

export const CommitMessageSettingsSchema = Type.Object({
  preferredModel: Type.String(),
  systemPrompt: Type.String({ minLength: 1 }),
  maxDiffKb: Type.Integer({
    minimum: COMMIT_MESSAGE_MAX_DIFF_KB_MIN,
    maximum: COMMIT_MESSAGE_MAX_DIFF_KB_MAX,
  }),
});

export const GitSettingsSchema = Type.Object({
  signCommits: Type.Boolean(),
  signOff: Type.Boolean(),
  commitMessage: CommitMessageSettingsSchema,
});

/** Off by default: the external HTTP API surface is opt-in per user. */
export const ExternalApiSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
});

const AppSettingsFieldsSchema = {
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
  workspaceSettings: WorkspaceSettingsSchema,
  gitSettings: GitSettingsSchema,
  chatDisplaySettings: ChatDisplaySettingsSchema,
  externalApiSettings: ExternalApiSettingsSchema,
  externalAgentSettings: ExternalAgentSettingsSchema,
} as const;

export const AppSettingsSchema = Type.Object({
  ...AppSettingsFieldsSchema,
  profileSettings: ProfileSettingsMapSchema,
});

export const AppSettingsPutBodySchema = Type.Object({
  ...AppSettingsFieldsSchema,
  profileSettings: ProfileSettingsMapPutSchema,
});

export type ImageQuality = Static<typeof ImageQualitySchema>;
export type DiffPreviewMode = Static<typeof DiffPreviewModeSchema>;
export type ChatDisplaySettings = Static<typeof ChatDisplaySettingsSchema>;
export type ChatTitleSettings = Static<typeof ChatTitleSettingsSchema>;
export type ChatTitleStrategy = ChatTitleSettings['strategy'];
export type MultiAgentSettings = Static<typeof MultiAgentSettingsSchema>;
export type LibraryLocationToggles = Static<typeof LibraryLocationTogglesSchema>;
export type LibraryLocationSettings = Static<typeof LibraryLocationSettingsSchema>;
export type ProfileScopedSettings = Static<typeof ProfileScopedSettingsSchema>;
export type ProfileSettingsMap = Static<typeof ProfileSettingsMapSchema>;
export type CommitMessageSettings = Static<typeof CommitMessageSettingsSchema>;
export type GitSettings = Static<typeof GitSettingsSchema>;
export type ExternalApiSettings = Static<typeof ExternalApiSettingsSchema>;
export type AppSettings = Static<typeof AppSettingsSchema>;
export type AppSettingsPutBody = Static<typeof AppSettingsPutBodySchema>;
