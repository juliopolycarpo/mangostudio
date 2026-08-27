import Type, { type Static } from 'typebox';

export const DirectoryEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  hidden: Type.Optional(Type.Boolean()),
});

export const ListDirectoryResponseSchema = Type.Object({
  path: Type.String(),
  parent: Type.Union([Type.String(), Type.Null()]),
  entries: Type.Array(DirectoryEntrySchema),
  home: Type.String(),
  roots: Type.Array(Type.String()),
  separator: Type.Union([Type.Literal('/'), Type.Literal('\\')]),
  truncated: Type.Optional(Type.Boolean()),
});

export const ListDirectoryQuerySchema = Type.Object({
  path: Type.Optional(Type.String()),
  chatId: Type.Optional(Type.String({ minLength: 1 })),
});

export const ValidatePathBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  chatId: Type.Optional(Type.String({ minLength: 1 })),
});

export const WorkdirValidationReasonSchema = Type.Union([
  Type.Literal('not-found'),
  Type.Literal('not-a-directory'),
  Type.Literal('permission-denied'),
]);

export const ValidatePathResponseSchema = Type.Object({
  ok: Type.Boolean(),
  resolvedPath: Type.Optional(Type.String()),
  reason: Type.Optional(WorkdirValidationReasonSchema),
});

/** Upper bound on remembered working directories, shared by the schema, normalizer, and UI. */
export const RECENT_WORKDIRS_MAX = 10;

/**
 * Rail panels in their default order. `github` sits next to `git` because the
 * two answer the same question one step apart — what changed locally, and what
 * that change looks like once it is a pull request.
 *
 * This array and `WorkspacePanelIdSchema` below are two hand-written halves of
 * one list: TypeBox needs the literal tuple spelled out to infer the union, so
 * adding a panel means editing both. Everything downstream — `maxItems`, the
 * settings normalizer's backfill, the rail — reads one of these two.
 */
export const WORKSPACE_PANEL_IDS = ['git', 'github', 'todos'] as const;
export const WORKSPACE_PANEL_WIDTH_MIN = 280;
export const WORKSPACE_PANEL_WIDTH_MAX = 640;
export const WORKSPACE_PANEL_WIDTH_DEFAULT = 360;

/** Preferred width of the desktop chat-list sidebar. */
export const CHAT_SIDEBAR_WIDTH_MIN = 240;
export const CHAT_SIDEBAR_WIDTH_MAX = 420;
export const CHAT_SIDEBAR_WIDTH_DEFAULT = 256;

/** The schema half of `WORKSPACE_PANEL_IDS`; the two must list the same ids. */
export const WorkspacePanelIdSchema = Type.Union([
  Type.Literal('git'),
  Type.Literal('github'),
  Type.Literal('todos'),
]);

export const WorkspacePanelSettingsSchema = Type.Object({
  visiblePanelIds: Type.Array(WorkspacePanelIdSchema, {
    maxItems: WORKSPACE_PANEL_IDS.length,
    uniqueItems: true,
  }),
  panelOrder: Type.Array(WorkspacePanelIdSchema, {
    maxItems: WORKSPACE_PANEL_IDS.length,
    uniqueItems: true,
  }),
  width: Type.Integer({
    minimum: WORKSPACE_PANEL_WIDTH_MIN,
    maximum: WORKSPACE_PANEL_WIDTH_MAX,
  }),
});

export const WorkspaceSettingsSchema = Type.Object({
  defaultWorkdir: Type.String(),
  recentWorkdirs: Type.Array(Type.String(), { maxItems: RECENT_WORKDIRS_MAX }),
  restrictToolsToWorkdir: Type.Boolean(),
  chatSidebarWidth: Type.Integer({
    minimum: CHAT_SIDEBAR_WIDTH_MIN,
    maximum: CHAT_SIDEBAR_WIDTH_MAX,
  }),
  sidePanel: WorkspacePanelSettingsSchema,
});

export type DirectoryEntry = Static<typeof DirectoryEntrySchema>;
export type ListDirectoryResponse = Static<typeof ListDirectoryResponseSchema>;
export type ListDirectoryQuery = Static<typeof ListDirectoryQuerySchema>;
export type ValidatePathBody = Static<typeof ValidatePathBodySchema>;
export type WorkdirValidationReason = Static<typeof WorkdirValidationReasonSchema>;
export type ValidatePathResponse = Static<typeof ValidatePathResponseSchema>;
export type WorkspacePanelId = Static<typeof WorkspacePanelIdSchema>;
export type WorkspacePanelSettings = Static<typeof WorkspacePanelSettingsSchema>;
export type WorkspaceSettings = Static<typeof WorkspaceSettingsSchema>;
