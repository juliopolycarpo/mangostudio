import { type Static, Type } from '@sinclair/typebox';
import { ApiErrorResponseSchema, SSEErrorEventSchema } from '../errors';
import { LibraryLocationStatusSchema, LibraryTargetIdSchema } from '../library';
import { ProfileIdSchema } from '../profiles';

export const RuntimeIdSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('node'),
  Type.Literal('nvm'),
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

export const RuntimeOriginSchema = Type.Union([
  Type.Literal('path'),
  Type.Literal('well-known'),
  Type.Literal('version-manager'),
  Type.Literal('configured'),
]);

export const VersionManagerIdSchema = Type.Union([
  Type.Literal('nvm'),
  Type.Literal('fnm'),
  Type.Literal('volta'),
]);

export const LtsStatusSchema = Type.Union([
  Type.Literal('current-lts'),
  Type.Literal('lts-outdated-patch'),
  Type.Literal('lts-superseded'),
  Type.Literal('end-of-life'),
  Type.Literal('current-release'),
  Type.Literal('unknown'),
]);

export const RuntimeHealthSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('warn'),
  Type.Literal('missing'),
  Type.Literal('error'),
]);

export const RuntimeFindingCodeSchema = Type.Union([
  Type.Literal('not-found'),
  Type.Literal('installed-but-not-on-path'),
  Type.Literal('shadowed-by-earlier-path'),
  Type.Literal('multiple-versions'),
  Type.Literal('version-below-minimum'),
  Type.Literal('not-executable'),
  Type.Literal('outdated-lts'),
  Type.Literal('managed-but-not-on-path'),
  Type.Literal('probe-timeout'),
  Type.Literal('cli-not-installed'),
  Type.Literal('config-home-missing'),
  Type.Literal('not-authenticated'),
  Type.Literal('version-probe-failed'),
  Type.Literal('location-unwritable'),
]);

export const AgentAuthSignalSchema = Type.Union([
  Type.Literal('file-present'),
  Type.Literal('file-absent'),
  Type.Literal('config-key-present'),
  Type.Literal('session'),
  Type.Literal('unknown'),
]);

export const RuntimeInstallationSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  rawPath: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  origin: RuntimeOriginSchema,
  pathIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  effective: Type.Boolean(),
  aliasOf: Type.Optional(Type.String({ minLength: 1 })),
  managedBy: Type.Optional(VersionManagerIdSchema),
});

export const RuntimeFindingSchema = Type.Object({
  code: RuntimeFindingCodeSchema,
  params: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const RuntimeStatusSchema = Type.Object({
  id: RuntimeIdSchema,
  health: RuntimeHealthSchema,
  installations: Type.Array(RuntimeInstallationSchema),
  effective: Type.Optional(RuntimeInstallationSchema),
  findings: Type.Array(RuntimeFindingSchema),
  installable: Type.Boolean(),
  probedAtMs: Type.Number({ minimum: 0 }),
});

export const RuntimeStatusListSchema = Type.Array(RuntimeStatusSchema);

export const AgentCliStatusSchema = Type.Composite([
  RuntimeStatusSchema,
  Type.Object({
    targetId: LibraryTargetIdSchema,
    configHome: Type.String({ minLength: 1 }),
    configHomeExists: Type.Boolean(),
    authenticated: Type.Boolean(),
    authSignal: AgentAuthSignalSchema,
    locations: Type.Array(LibraryLocationStatusSchema),
  }),
]);

export const AgentCliStatusListSchema = Type.Array(AgentCliStatusSchema);

export const ManagedVersionSchema = Type.Object({
  version: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  isDefault: Type.Boolean(),
  isCurrent: Type.Boolean(),
  ltsStatus: LtsStatusSchema,
  ltsCodename: Type.Optional(Type.String({ minLength: 1 })),
});

export const VersionManagerStatusSchema = Type.Object({
  id: VersionManagerIdSchema,
  installed: Type.Boolean(),
  root: Type.Optional(Type.String({ minLength: 1 })),
  managerVersion: Type.Optional(Type.String({ minLength: 1 })),
  versions: Type.Array(ManagedVersionSchema),
  defaultAlias: Type.Optional(Type.String({ minLength: 1 })),
  defaultVersion: Type.Optional(Type.String({ minLength: 1 })),
  currentVersion: Type.Optional(Type.String({ minLength: 1 })),
  findings: Type.Array(RuntimeFindingSchema),
});

export const VersionManagerStatusListSchema = Type.Array(VersionManagerStatusSchema);

export const InstallRecipeIdSchema = Type.Union([
  Type.Literal('bun.install.official'),
  Type.Literal('bun.update'),
  Type.Literal('nvm.install'),
  Type.Literal('nvm.node.install'),
  Type.Literal('nvm.node.set-default'),
  Type.Literal('claude.install'),
  Type.Literal('codex.install'),
  Type.Literal('cursor.install'),
]);

export const InstallActionSchema = Type.Union([
  Type.Literal('install'),
  Type.Literal('update'),
  Type.Literal('use-version'),
  Type.Literal('set-default'),
]);

export const InstallPlatformSchema = Type.Union([Type.Literal('darwin'), Type.Literal('linux')]);

export const NodeVersionSpecSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^(?:lts|latest|\\d+(?:\\.\\d+){0,2})$',
});

export const RecipeInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('none'),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal('node-version'),
      version: NodeVersionSpecSchema,
    },
    { additionalProperties: false }
  ),
]);

export const InstallGuardReasonSchema = Type.Union([
  Type.Literal('container'),
  Type.Literal('server-not-loopback'),
  Type.Literal('client-not-loopback'),
  Type.Literal('disabled'),
]);

export const InstallGuardSchema = Type.Object({
  allowed: Type.Boolean(),
  reasons: Type.Array(InstallGuardReasonSchema),
});

export const InstallRecipeDownloadSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  sha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
});

export const InstallProfileSetupSchema = Type.Object({
  lines: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  present: Type.Boolean(),
  detectedIn: Type.Array(Type.String({ minLength: 1 })),
});

export const InstallRecipePreviewSchema = Type.Object({
  id: InstallRecipeIdSchema,
  runtimeId: RuntimeIdSchema,
  action: InstallActionSchema,
  inputKind: Type.Union([Type.Literal('none'), Type.Literal('node-version')]),
  platforms: Type.Array(InstallPlatformSchema),
  argv: Type.Array(Type.String()),
  copyCommand: Type.String({ minLength: 1 }),
  requires: Type.Array(RuntimeIdSchema),
  writes: Type.Array(Type.String()),
  networkAccess: Type.Boolean(),
  timeoutMs: Type.Integer({ minimum: 1 }),
  supported: Type.Boolean(),
  missingRequirements: Type.Array(RuntimeIdSchema),
  guard: InstallGuardSchema,
  download: Type.Optional(InstallRecipeDownloadSchema),
  profileSetup: Type.Optional(InstallProfileSetupSchema),
});

export const InstallPrepareBodySchema = Type.Object(
  {
    recipeId: InstallRecipeIdSchema,
    input: RecipeInputSchema,
    /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
    profileId: Type.Optional(ProfileIdSchema),
  },
  { additionalProperties: false }
);

export const InstallPreparationSchema = Type.Object({
  preparationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  expiresAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  recipe: InstallRecipePreviewSchema,
});

export const InstallStartBodySchema = Type.Object(
  {
    recipeId: InstallRecipeIdSchema,
    input: RecipeInputSchema,
    preparationId: Type.Optional(Type.String({ minLength: 1 })),
    /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
    profileId: Type.Optional(ProfileIdSchema),
  },
  { additionalProperties: false }
);

export const InstallStartResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  attached: Type.Boolean(),
});

export const InstallCancelResponseSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  cancellationRequested: Type.Boolean(),
});

export const InstallBlockedResponseSchema = Type.Composite([
  ApiErrorResponseSchema,
  Type.Object({
    recipe: InstallRecipePreviewSchema,
  }),
]);

export const InstallRunStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed-out'),
  Type.Literal('spawn-failed'),
  /**
   * The server stopped while the installer was running. The installer may have
   * completed, partially completed, or never finished — the outcome is unknown
   * and is deliberately not reported as a failure.
   */
  Type.Literal('interrupted'),
]);

export const InstallRunSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  recipeId: InstallRecipeIdSchema,
  argv: Type.Array(Type.String()),
  startedAt: Type.Number({ minimum: 0 }),
  finishedAt: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  status: InstallRunStatusSchema,
  truncated: Type.Boolean(),
});

export const InstallRunListSchema = Type.Array(InstallRunSchema);

export const InstallLogEventSchema = Type.Object({
  type: Type.Literal('log'),
  stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr'), Type.Literal('system')]),
  line: Type.String(),
  done: Type.Literal(false),
});

export const InstallProbeEventSchema = Type.Object({
  type: Type.Literal('probe'),
  target: Type.Union([
    Type.Literal('runtime'),
    Type.Literal('version-manager'),
    Type.Literal('agent'),
  ]),
  status: Type.Union([RuntimeStatusSchema, VersionManagerStatusSchema, AgentCliStatusSchema]),
  done: Type.Literal(false),
});

export const InstallExitEventSchema = Type.Object({
  type: Type.Literal('exit'),
  code: Type.Union([Type.Integer(), Type.Null()]),
  status: Type.Exclude(InstallRunStatusSchema, Type.Literal('running')),
  truncated: Type.Boolean(),
  durationMs: Type.Number({ minimum: 0 }),
  done: Type.Literal(true),
});

export const InstallStreamEventSchema = Type.Union([
  InstallLogEventSchema,
  InstallProbeEventSchema,
  InstallExitEventSchema,
  SSEErrorEventSchema,
]);

export type RuntimeId = Static<typeof RuntimeIdSchema>;
export type RuntimeOrigin = Static<typeof RuntimeOriginSchema>;
export type VersionManagerId = Static<typeof VersionManagerIdSchema>;
export type LtsStatus = Static<typeof LtsStatusSchema>;
export type RuntimeHealth = Static<typeof RuntimeHealthSchema>;
export type RuntimeFindingCode = Static<typeof RuntimeFindingCodeSchema>;
export type RuntimeInstallation = Static<typeof RuntimeInstallationSchema>;
export type RuntimeFinding = Static<typeof RuntimeFindingSchema>;
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
export type RuntimeStatusList = Static<typeof RuntimeStatusListSchema>;
export type AgentAuthSignal = Static<typeof AgentAuthSignalSchema>;
export type AgentCliStatus = Static<typeof AgentCliStatusSchema>;
export type AgentCliStatusList = Static<typeof AgentCliStatusListSchema>;
export type ManagedVersion = Static<typeof ManagedVersionSchema>;
export type VersionManagerStatus = Static<typeof VersionManagerStatusSchema>;
export type VersionManagerStatusList = Static<typeof VersionManagerStatusListSchema>;
export type InstallRecipeId = Static<typeof InstallRecipeIdSchema>;
export type InstallAction = Static<typeof InstallActionSchema>;
export type InstallPlatform = Static<typeof InstallPlatformSchema>;
export type NodeVersionSpec = Static<typeof NodeVersionSpecSchema>;
export type RecipeInput = Static<typeof RecipeInputSchema>;
export type InstallGuardReason = Static<typeof InstallGuardReasonSchema>;
export type InstallGuard = Static<typeof InstallGuardSchema>;
export type InstallRecipeDownload = Static<typeof InstallRecipeDownloadSchema>;
export type InstallProfileSetup = Static<typeof InstallProfileSetupSchema>;
export type InstallRecipePreview = Static<typeof InstallRecipePreviewSchema>;
export type InstallPrepareBody = Static<typeof InstallPrepareBodySchema>;
export type InstallPreparation = Static<typeof InstallPreparationSchema>;
export type InstallStartBody = Static<typeof InstallStartBodySchema>;
export type InstallStartResponse = Static<typeof InstallStartResponseSchema>;
export type InstallCancelResponse = Static<typeof InstallCancelResponseSchema>;
export type InstallBlockedResponse = Static<typeof InstallBlockedResponseSchema>;
export type InstallRunStatus = Static<typeof InstallRunStatusSchema>;
export type InstallRun = Static<typeof InstallRunSchema>;
export type InstallRunList = Static<typeof InstallRunListSchema>;
export type InstallLogEvent = Static<typeof InstallLogEventSchema>;
export type InstallProbeEvent = Static<typeof InstallProbeEventSchema>;
export type InstallExitEvent = Static<typeof InstallExitEventSchema>;
export type InstallStreamEvent = Static<typeof InstallStreamEventSchema>;
