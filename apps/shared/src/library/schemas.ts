import { type Static, Type } from '@sinclair/typebox';
import { ProfileIdSchema } from '../profiles';
import type { SkillSource } from '../skills';

export const ResourceKindSchema = Type.Union([
  Type.Literal('skill'),
  Type.Literal('subagent'),
  Type.Literal('instruction'),
  Type.Literal('setting'),
  Type.Literal('hook'),
]);

export const LibraryTargetIdSchema = Type.Union([
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

/** Stable id of one code-defined library location. */
export const LibraryLocationIdSchema = Type.String({ minLength: 1, maxLength: 64 });

export const LocationAccessSchema = Type.Union([
  Type.Literal('read-write'),
  Type.Literal('read-only'),
]);

export const ResourceFormatSchema = Type.Union([
  Type.Literal('markdown-plain'),
  Type.Literal('markdown-frontmatter'),
  Type.Literal('mdc'),
  Type.Literal('toml-agent'),
  Type.Literal('agent-profile-db'),
  Type.Literal('json-settings'),
  Type.Literal('toml-settings'),
  Type.Literal('rules-dsl'),
]);

export const LibraryInvalidReasonSchema = Type.Union([
  Type.Literal('path-escape'),
  Type.Literal('invalid-slug'),
  Type.Literal('missing-entrypoint'),
  Type.Literal('unexpected-entry-type'),
  Type.Literal('unreadable'),
  Type.Literal('too-large'),
  Type.Literal('invalid-metadata'),
]);

export const LIBRARY_RESOURCE_SLUG_MAX_LENGTH = 128;

/**
 * Path-safe shape a library resource slug must satisfy: dot-separated groups of
 * `[A-Za-z0-9_-]`. Rejects separators, `..`, leading/trailing dots, drive/stream
 * colons, whitespace and control characters, so a slug is always safe to use as
 * a single directory name or file stem.
 */
export const LIBRARY_RESOURCE_SLUG_PATTERN = '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$';

export const LibraryResourceRefSchema = Type.Object({
  kind: ResourceKindSchema,
  /** Logical name: skill directory name or file stem for file-backed resources. */
  slug: Type.String({
    minLength: 1,
    maxLength: LIBRARY_RESOURCE_SLUG_MAX_LENGTH,
    pattern: LIBRARY_RESOURCE_SLUG_PATTERN,
  }),
});

const libraryInstanceBase = {
  locationId: LibraryLocationIdSchema,
  /** Absolute path of the file or directory backing this instance. */
  path: Type.String({ minLength: 1 }),
  modifiedAtMs: Type.Integer({ minimum: 0 }),
  format: ResourceFormatSchema,
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
};

/** An instance whose content was read end to end, so it can be hashed and compared. */
export const ValidLibraryInstanceSchema = Type.Object({
  ...libraryInstanceBase,
  valid: Type.Literal(true),
  contentHash: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
});

/**
 * An instance that exists on disk but could not be hashed. It carries no `contentHash`,
 * so it never joins a `LibraryContentGroup` and never counts toward divergence.
 */
export const InvalidLibraryInstanceSchema = Type.Object({
  ...libraryInstanceBase,
  valid: Type.Literal(false),
  /**
   * Metadata-invalid resources can still be hashed. I/O and containment
   * failures omit these fields because no trustworthy digest exists.
   */
  contentHash: Type.Optional(Type.String({ minLength: 1 })),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Why `valid` is false — a stable code, never free text. */
  invalidReason: LibraryInvalidReasonSchema,
});

export const LibraryInstanceSchema = Type.Union([
  ValidLibraryInstanceSchema,
  InvalidLibraryInstanceSchema,
]);

export const LibraryCoverageStateSchema = Type.Union([
  Type.Literal('present'),
  Type.Literal('absent'),
  Type.Literal('shadowed'),
]);

export const LibraryCoverageSchema = Type.Object({
  targetId: LibraryTargetIdSchema,
  state: LibraryCoverageStateSchema,
  effectiveLocationId: Type.Optional(LibraryLocationIdSchema),
  shadowedLocationIds: Type.Array(LibraryLocationIdSchema),
});

export const LibraryDivergenceSchema = Type.Union([
  Type.Literal('uniform'),
  Type.Literal('divergent'),
  Type.Literal('single'),
  /**
   * Copies exist but comparing them says nothing actionable: the kind is
   * read-only everywhere, and its files are different formats per vendor. The
   * content groups are still reported; only the verdict is withheld.
   */
  Type.Literal('not-comparable'),
]);

export const LibraryContentGroupSchema = Type.Object({
  contentHash: Type.String({ minLength: 1 }),
  locationIds: Type.Array(LibraryLocationIdSchema),
  instanceCount: Type.Integer({ minimum: 1 }),
});

export const LibraryResourceSchema = Type.Object({
  ref: LibraryResourceRefSchema,
  /** Stable identity for URLs and mutation keys: `<kind>:<slug>`. */
  key: Type.String({ minLength: 1 }),
  instances: Type.Array(LibraryInstanceSchema),
  coverage: Type.Array(LibraryCoverageSchema),
  divergence: LibraryDivergenceSchema,
  /** True when divergent text instances become identical after whitespace removal. */
  whitespaceOnlyDivergence: Type.Boolean(),
  /** Distinct content hashes, most-replicated first. */
  contentGroups: Type.Array(LibraryContentGroupSchema),
});

export const LibraryResourceListSchema = Type.Array(LibraryResourceSchema);

export const LibraryResourceContentSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  locationId: LibraryLocationIdSchema,
  content: Type.String(),
  truncated: Type.Boolean(),
  sizeBytes: Type.Integer({ minimum: 0 }),
});

export const LibraryLocationStatusSchema = Type.Object({
  id: LibraryLocationIdSchema,
  kind: ResourceKindSchema,
  /** Null when the code-defined location is unsupported on this platform. */
  path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  access: LocationAccessSchema,
  exists: Type.Boolean(),
  readable: Type.Boolean(),
  writable: Type.Boolean(),
  targetIds: Type.Array(LibraryTargetIdSchema),
  entryCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const LibraryLocationStatusListSchema = Type.Array(LibraryLocationStatusSchema);

export const SettingsFieldPresentationSchema = Type.Union([
  Type.Literal('value'),
  Type.Literal('redacted'),
  Type.Literal('omitted'),
]);

export const SettingsFieldSchema = Type.Union([
  Type.Object({
    path: Type.String({ minLength: 1 }),
    presentation: Type.Literal('value'),
    value: Type.String(),
  }),
  Type.Object({
    path: Type.String({ minLength: 1 }),
    presentation: Type.Literal('redacted'),
  }),
  Type.Object({
    path: Type.String({ minLength: 1 }),
    presentation: Type.Literal('omitted'),
  }),
]);

export const SettingsParseFailureReasonSchema = Type.Union([
  Type.Literal('invalid-json'),
  Type.Literal('invalid-toml'),
  Type.Literal('unreadable'),
  Type.Literal('not-regular-file'),
  Type.Literal('too-large'),
]);

export const SettingsSourceSnapshotSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  kind: Type.Union([Type.Literal('setting'), Type.Literal('hook')]),
  present: Type.Boolean(),
  parsed: Type.Boolean(),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  failureReason: Type.Optional(SettingsParseFailureReasonSchema),
  fields: Type.Array(SettingsFieldSchema),
});

export const SettingsSnapshotSchema = Type.Object({
  targetId: LibraryTargetIdSchema,
  sources: Type.Array(SettingsSourceSnapshotSchema),
});

export const SettingsSnapshotListSchema = Type.Array(SettingsSnapshotSchema);

export const SettingsConceptSchema = Type.Union([
  Type.Literal('default-permission-mode'),
  Type.Literal('allow-list'),
  Type.Literal('deny-list'),
  Type.Literal('selected-model'),
  Type.Literal('reasoning-effort'),
]);

export const ConceptComparisonEntrySchema = Type.Object({
  targetId: LibraryTargetIdSchema,
  state: Type.Union([
    Type.Literal('detected'),
    Type.Literal('not-detected'),
    Type.Literal('not-applicable'),
  ]),
  fields: Type.Array(SettingsFieldSchema),
});

export const ConceptComparisonSchema = Type.Object({
  concept: SettingsConceptSchema,
  /** Navigation aid only: vendor settings with similar intent are not equivalent. */
  comparability: Type.Literal('rough'),
  entries: Type.Array(ConceptComparisonEntrySchema),
});

export const ConceptComparisonListSchema = Type.Array(ConceptComparisonSchema);

const LibraryTargetReadsSchema = Type.Object({
  skill: Type.Array(LibraryLocationIdSchema),
  subagent: Type.Array(LibraryLocationIdSchema),
  instruction: Type.Array(LibraryLocationIdSchema),
  setting: Type.Array(LibraryLocationIdSchema),
  hook: Type.Array(LibraryLocationIdSchema),
});

export const LibraryTargetDescriptorSchema = Type.Object({
  id: LibraryTargetIdSchema,
  /** Key in the shared i18n catalog, never a user-visible literal. */
  displayNameKey: Type.String({ minLength: 1 }),
  /** Per-kind location precedence, highest priority first. */
  reads: LibraryTargetReadsSchema,
});

export const LibraryTargetDescriptorListSchema = Type.Array(LibraryTargetDescriptorSchema);

/**
 * How a resource's bytes are rewritten when the destination stores a different
 * format than the source. `verbatim` copies the bytes unchanged, `mechanical` is
 * a deterministic framing transform, and `agent` drafts the conversion with a
 * model. No strategy ever applies itself: every one produces a reviewed write.
 */
export const AdapterStrategySchema = Type.Union([
  Type.Literal('verbatim'),
  Type.Literal('mechanical'),
  Type.Literal('agent'),
]);

export const AdaptNoteSchema = Type.Object({
  code: Type.Union([
    Type.Literal('metadata-added'),
    Type.Literal('field-dropped'),
    Type.Literal('semantic-rewrite'),
  ]),
  message: Type.String({ minLength: 1 }),
  field: Type.Optional(Type.String({ minLength: 1 })),
});

export const AdaptProvenanceSchema = Type.Object({
  modelId: Type.String({ minLength: 1 }),
  promptVersion: Type.String({ minLength: 1 }),
});

export const PropagationOperationSchema = Type.Union([
  Type.Literal('create'),
  Type.Literal('overwrite'),
  Type.Literal('noop'),
  Type.Literal('adapt-create'),
  Type.Literal('adapt-overwrite'),
  Type.Literal('blocked'),
]);

/** Stable code for why a write cannot happen — never free text. */
export const PropagationBlockedReasonSchema = Type.Union([
  Type.Literal('read-only-location'),
  Type.Literal('unsupported-location'),
  Type.Literal('location-unwritable'),
  /** A `single-file` destination stores one named resource, and this is not it. */
  Type.Literal('slug-mismatch'),
  /**
   * The destination holds an instance the scanner could not read end to end.
   * Overwriting it is exactly the case where a backup is least trustworthy, so
   * an invalid destination blocks instead of classifying as `overwrite`.
   */
  Type.Literal('invalid-destination'),
  /** No instance of the resource could be hashed, so there is nothing to copy. */
  Type.Literal('no-source-content'),
  /** The destination's format differs and no adapter offers a conversion. */
  Type.Literal('no-adapter-strategy'),
]);

export const PropagationAdaptationSchema = Type.Object({
  fromFormat: ResourceFormatSchema,
  toFormat: ResourceFormatSchema,
  availableStrategies: Type.Array(AdapterStrategySchema),
  recommendedStrategy: Type.Optional(AdapterStrategySchema),
});

/**
 * One candidate winner: a distinct content hash plus the facts a human needs to
 * choose between versions. Only groups backed by at least one readable instance
 * appear, because an unreadable copy can never be the version that wins.
 */
export const PropagationSourceGroupSchema = Type.Object({
  contentHash: Type.String({ minLength: 1 }),
  locationIds: Type.Array(LibraryLocationIdSchema),
  instanceCount: Type.Integer({ minimum: 1 }),
  /**
   * Formats the identical bytes are stored under. Normally one; two locations
   * of different formats can still land in one group when their bytes match.
   */
  formats: Type.Array(ResourceFormatSchema),
  newestModifiedAtMs: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  /** Location to read this group's bytes from, for the diff viewer. */
  contentLocationId: LibraryLocationIdSchema,
  /** Absolute path of that copy — the source an apply reads from. */
  contentPath: Type.String({ minLength: 1 }),
});

/**
 * What writing one candidate winner into one destination would do. Preview
 * enumerates an outcome per source group rather than assuming a winner: picking
 * one is the user's decision (D5), and the operation depends on which they pick.
 */
export const PropagationOutcomeSchema = Type.Object({
  winnerContentHash: Type.String({ minLength: 1 }),
  operation: PropagationOperationSchema,
  adaptation: Type.Optional(PropagationAdaptationSchema),
  blockedReason: Type.Optional(PropagationBlockedReasonSchema),
});

export const PropagationDestinationSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  /** Every target served by writing here — one write can cover several. */
  targetIds: Type.Array(LibraryTargetIdSchema),
  toFormat: ResourceFormatSchema,
  /** Absolute path the write would land on; null where the location is unsupported. */
  path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  /** Hash of what is there now, absent when the destination holds nothing. */
  currentContentHash: Type.Optional(Type.String({ minLength: 1 })),
  /** Set when no winner can be written here; `outcomes` is then empty. */
  blockedReason: Type.Optional(PropagationBlockedReasonSchema),
  outcomes: Type.Array(PropagationOutcomeSchema),
});

export const PropagationPreviewEntrySchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  ref: LibraryResourceRefSchema,
  divergence: LibraryDivergenceSchema,
  sourceGroups: Type.Array(PropagationSourceGroupSchema),
  /** True when more than one group could win, so an apply must name one. */
  requiresWinnerSelection: Type.Boolean(),
  /** True while the user has accepted this exact set of diverging hashes. */
  acknowledgedDivergence: Type.Boolean(),
  destinations: Type.Array(PropagationDestinationSchema),
});

export const PROPAGATION_PREVIEW_MAX_RESOURCES = 200;

export const PropagationPreviewRequestSchema = Type.Object({
  resourceKeys: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: PROPAGATION_PREVIEW_MAX_RESOURCES,
  }),
  targetLocationIds: Type.Array(LibraryLocationIdSchema, { minItems: 1, maxItems: 64 }),
  /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
  profileId: Type.Optional(ProfileIdSchema),
});

export const PropagationPreviewSchema = Type.Object({
  /** Binds an apply to this exact preview; a re-preview mints a new one. */
  previewToken: Type.String({ minLength: 1 }),
  /**
   * Covers every source instance and every destination's current state. An
   * apply against a changed hash is rejected rather than overwriting an edit
   * the user made after previewing.
   */
  stateHash: Type.String({ minLength: 1 }),
  entries: Type.Array(PropagationPreviewEntrySchema),
});

/**
 * How the user settled a resource before it is written anywhere.
 *
 * `keep-per-location` is not a lesser option: sometimes copies *should* differ,
 * and saying so explicitly is a real outcome rather than a deferral.
 */
export const PropagationResolutionSchema = Type.Union([
  Type.Literal('adopt-group'),
  Type.Literal('keep-per-location'),
  Type.Literal('edit-then-adopt'),
]);

export const PropagationDestinationDecisionSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  action: Type.Union([Type.Literal('apply'), Type.Literal('skip')]),
  strategy: Type.Optional(AdapterStrategySchema),
});

export const PROPAGATION_MAX_EDITED_CONTENT_BYTES = 512 * 1024;

export const PropagationDecisionSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  resolution: PropagationResolutionSchema,
  /** Required by `adopt-group`; must name one of the entry's source groups. */
  winnerContentHash: Type.Optional(Type.String({ minLength: 1 })),
  /** Required by `edit-then-adopt`; becomes the winner, a hash held nowhere yet. */
  editedContent: Type.Optional(Type.String({ maxLength: PROPAGATION_MAX_EDITED_CONTENT_BYTES })),
  /** Every destination the preview offered, each explicitly applied or skipped. */
  destinations: Type.Array(PropagationDestinationDecisionSchema),
});

export const PropagationApplyRequestSchema = Type.Object({
  previewToken: Type.String({ minLength: 1 }),
  stateHash: Type.String({ minLength: 1 }),
  /** The preview request this apply answers, so the token can be re-derived. */
  request: PropagationPreviewRequestSchema,
  decisions: Type.Array(PropagationDecisionSchema, {
    minItems: 1,
    maxItems: PROPAGATION_PREVIEW_MAX_RESOURCES,
  }),
  /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
  profileId: Type.Optional(ProfileIdSchema),
});

export const PropagationSkipReasonSchema = Type.Union([
  Type.Literal('user-skipped'),
  Type.Literal('already-in-sync'),
  Type.Literal('divergence-acknowledged'),
]);

export const PropagationFailureReasonSchema = Type.Union([
  Type.Literal('guard-rejected'),
  Type.Literal('adaptation-failed'),
  Type.Literal('write-failed'),
  /** The bytes on disk after the write did not hash to what was intended. */
  Type.Literal('verification-failed'),
]);

export const PropagationAppliedSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  locationId: LibraryLocationIdSchema,
  operation: PropagationOperationSchema,
  destinationPath: Type.String({ minLength: 1 }),
  /** Re-hashed from disk after the write, never assumed from the source. */
  contentHash: Type.String({ minLength: 1 }),
  adaptation: Type.Optional(
    Type.Object({
      strategy: AdapterStrategySchema,
      lossy: Type.Boolean(),
      requiresReview: Type.Boolean(),
      notes: Type.Array(AdaptNoteSchema),
      provenance: Type.Optional(AdaptProvenanceSchema),
    })
  ),
});

export const PropagationSkippedSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  locationId: Type.Optional(LibraryLocationIdSchema),
  reason: PropagationSkipReasonSchema,
});

export const PropagationFailureSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  locationId: LibraryLocationIdSchema,
  reason: PropagationFailureReasonSchema,
  message: Type.String(),
});

export const PropagationApplySchema = Type.Object({
  /** Present when anything was written; the handle `undo` takes. */
  backupId: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * False when the filesystem matches its pre-apply state — either everything
   * landed, or a failure was fully rolled back. True is the alarming case: a
   * failure whose compensation also failed, leaving some writes in place.
   */
  partial: Type.Boolean(),
  applied: Type.Array(PropagationAppliedSchema),
  skipped: Type.Array(PropagationSkippedSchema),
  failed: Type.Array(PropagationFailureSchema),
});

export const PropagationUndoRequestSchema = Type.Object({
  backupId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const PropagationUndoEntrySchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  destinationPath: Type.String({ minLength: 1 }),
});

export const PropagationUndoSkippedSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  destinationPath: Type.String({ minLength: 1 }),
  reason: Type.Union([
    /** Someone changed the destination after the apply; undo leaves it alone. */
    Type.Literal('changed-since-apply'),
    Type.Literal('backup-missing'),
  ]),
});

export const PropagationUndoSchema = Type.Object({
  backupId: Type.String({ minLength: 1 }),
  restored: Type.Array(PropagationUndoEntrySchema),
  removed: Type.Array(PropagationUndoEntrySchema),
  skipped: Type.Array(PropagationUndoSkippedSchema),
});

/**
 * What retained backups currently cost. Surfaced so a directory holding copies
 * of skill trees is never a mystery disk consumer the user has to discover.
 */
export const PropagationBackupUsageSchema = Type.Object({
  setCount: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  retentionCount: Type.Integer({ minimum: 1 }),
  retentionBytes: Type.Integer({ minimum: 1 }),
});

/**
 * A recorded "this divergence is intentional" — Cursor's copy of a skill is
 * sometimes meant to differ. Keyed by the exact hashes it covers, so editing any
 * copy makes the resource diverge again instead of muting it permanently.
 */
export const LibraryDivergenceAckSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  /** Sorted, so two clients observing the same divergence produce one key. */
  contentHashes: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
  acknowledgedAtMs: Type.Integer({ minimum: 0 }),
});

export const LibraryDivergenceAckListSchema = Type.Array(LibraryDivergenceAckSchema);

export const LibraryDivergenceAckRequestSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  /** What the client saw; a mismatch with disk rejects the acknowledgement. */
  contentHashes: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 64 }),
  /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
  profileId: Type.Optional(ProfileIdSchema),
});

export type ResourceKind = Static<typeof ResourceKindSchema>;
export type LibraryTargetId = Static<typeof LibraryTargetIdSchema>;
export type LibraryLocationId = Static<typeof LibraryLocationIdSchema>;
export type LocationAccess = Static<typeof LocationAccessSchema>;
export type ResourceFormat = Static<typeof ResourceFormatSchema>;
export type LibraryInvalidReason = Static<typeof LibraryInvalidReasonSchema>;
export type LibraryResourceRef = Static<typeof LibraryResourceRefSchema>;
export type ValidLibraryInstance = Static<typeof ValidLibraryInstanceSchema>;
export type InvalidLibraryInstance = Static<typeof InvalidLibraryInstanceSchema>;
export type LibraryInstance = Static<typeof LibraryInstanceSchema>;
export type LibraryCoverageState = Static<typeof LibraryCoverageStateSchema>;
export type LibraryCoverage = Static<typeof LibraryCoverageSchema>;
export type LibraryDivergence = Static<typeof LibraryDivergenceSchema>;
export type LibraryContentGroup = Static<typeof LibraryContentGroupSchema>;
export type LibraryResource = Static<typeof LibraryResourceSchema>;
export type LibraryResourceContent = Static<typeof LibraryResourceContentSchema>;
export type LibraryLocationStatus = Static<typeof LibraryLocationStatusSchema>;
export type SettingsFieldPresentation = Static<typeof SettingsFieldPresentationSchema>;
export type SettingsField = Static<typeof SettingsFieldSchema>;
export type SettingsParseFailureReason = Static<typeof SettingsParseFailureReasonSchema>;
export type SettingsSourceSnapshot = Static<typeof SettingsSourceSnapshotSchema>;
export type SettingsSnapshot = Static<typeof SettingsSnapshotSchema>;
export type SettingsConcept = Static<typeof SettingsConceptSchema>;
export type ConceptComparisonEntry = Static<typeof ConceptComparisonEntrySchema>;
export type ConceptComparison = Static<typeof ConceptComparisonSchema>;
export type LibraryTargetDescriptor = Static<typeof LibraryTargetDescriptorSchema>;
export type AdapterStrategy = Static<typeof AdapterStrategySchema>;
export type AdaptNote = Static<typeof AdaptNoteSchema>;
export type AdaptProvenance = Static<typeof AdaptProvenanceSchema>;
export type PropagationOperation = Static<typeof PropagationOperationSchema>;
export type PropagationBlockedReason = Static<typeof PropagationBlockedReasonSchema>;
export type PropagationAdaptation = Static<typeof PropagationAdaptationSchema>;
export type PropagationSourceGroup = Static<typeof PropagationSourceGroupSchema>;
export type PropagationOutcome = Static<typeof PropagationOutcomeSchema>;
export type PropagationDestination = Static<typeof PropagationDestinationSchema>;
export type PropagationPreviewEntry = Static<typeof PropagationPreviewEntrySchema>;
export type PropagationPreviewRequest = Static<typeof PropagationPreviewRequestSchema>;
export type PropagationPreview = Static<typeof PropagationPreviewSchema>;
export type PropagationResolution = Static<typeof PropagationResolutionSchema>;
export type PropagationDestinationDecision = Static<typeof PropagationDestinationDecisionSchema>;
export type PropagationDecision = Static<typeof PropagationDecisionSchema>;
export type PropagationApplyRequest = Static<typeof PropagationApplyRequestSchema>;
export type PropagationSkipReason = Static<typeof PropagationSkipReasonSchema>;
export type PropagationFailureReason = Static<typeof PropagationFailureReasonSchema>;
export type PropagationApplied = Static<typeof PropagationAppliedSchema>;
export type PropagationSkipped = Static<typeof PropagationSkippedSchema>;
export type PropagationFailure = Static<typeof PropagationFailureSchema>;
export type PropagationApply = Static<typeof PropagationApplySchema>;
export type PropagationUndoRequest = Static<typeof PropagationUndoRequestSchema>;
export type PropagationUndo = Static<typeof PropagationUndoSchema>;
export type PropagationBackupUsage = Static<typeof PropagationBackupUsageSchema>;
export type LibraryDivergenceAck = Static<typeof LibraryDivergenceAckSchema>;
export type LibraryDivergenceAckRequest = Static<typeof LibraryDivergenceAckRequestSchema>;

export const SKILL_SOURCE_TO_LOCATION_ID: Record<SkillSource, LibraryLocationId> = {
  mango: 'mango-skills',
  agents: 'agents-skills',
  claude: 'claude-skills',
};
