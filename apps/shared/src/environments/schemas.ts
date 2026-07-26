import { type Static, Type } from '@sinclair/typebox';
import { LibraryLocationStatusSchema, LibraryTargetIdSchema } from '../library';

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
