import Type, { type Static } from 'typebox';
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

/**
 * Which machine a library instance, destination, or backup set lives on.
 *
 * Structurally `EnvironmentIdSchema`, restated here rather than imported:
 * `shared/environments` already imports this module for location and target
 * shapes, so the dependency cannot invert without a cycle. The two are kept in
 * step by the parity test over the environments contract — a divergence would
 * mean an id the environments API accepts and the library API refuses.
 */
export const LibraryEnvironmentIdSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});

/**
 * Where a location is rooted. `home` resolves under the user's home directory.
 * `workspace` resolves under a repository root and is **reserved**: v1 defines
 * no workspace-scoped location, so nothing resolves under it yet.
 *
 * Scope is a field rather than a fork of the id space on purpose. The same
 * logical location exists at both scopes — `.claude/skills` under `~` and under
 * a repository are one concept read from two roots — so ids stay scope-free and
 * every map keyed on them stays one map.
 *
 * If no workspace location exists when this stops earning its keep, delete the
 * seam rather than leaving it as decoration.
 */
export const LibraryScopeSchema = Type.Union([Type.Literal('home'), Type.Literal('workspace')]);

/**
 * Runtime companion to `LibraryScopeSchema`. Iterating scopes is a normal need
 * — nesting settings, building per-scope caches — and re-deriving the list from
 * the schema at every call site is how one of them ends up out of date.
 */
export const LIBRARY_SCOPES = ['home', 'workspace'] as const;

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
  /** A directory manifest entry whose relative path carries a `\n` or `\0` byte. */
  Type.Literal('unsafe-name'),
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

/**
 * Why an on-disk entry could not even be named as a {@link LibraryResourceRefSchema}: its name
 * fails `LIBRARY_RESOURCE_SLUG_PATTERN` outright. Deliberately small and disjoint from
 * `LibraryInvalidReasonSchema`, which says why a *nameable* resource is invalid — this union says
 * why an entry cannot be named at all. A union of one for now: every member has to be emitted by
 * a reader and rendered with its own string, so a member is added when a reader needs it, not
 * ahead of one.
 */
export const LibraryUnreadableEntryReasonSchema = Type.Union([Type.Literal('invalid-name')]);

export const LibraryUnreadableEntrySchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  /** Raw directory or file name from disk. Untrusted: render as text, never as a path or link. */
  name: Type.String({ minLength: 1 }),
  reason: LibraryUnreadableEntryReasonSchema,
});

/**
 * A scan's full answer: the resources it could name, plus the entries it could not. Kept as one
 * channel outside `resources` rather than relaxing the ref shape, so a slug is always safe to use
 * as a path segment everywhere one becomes a filesystem path.
 */
export const LibraryScanResultSchema = Type.Object({
  resources: LibraryResourceListSchema,
  unreadableEntries: Type.Array(LibraryUnreadableEntrySchema),
});

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
  scope: LibraryScopeSchema,
  /**
   * Null when the location is unsupported on this platform, and — once
   * workspace locations exist — when its scope has no root to resolve against.
   */
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
  /**
   * The machine is not connected. Its locations cannot be inspected, so nothing
   * can be said about what a write there would do — and a preview that guessed
   * would be describing a disk nobody looked at.
   */
  Type.Literal('environment-offline'),
  /** The machine's runtime does not advertise the library feature at all. */
  Type.Literal('environment-unsupported'),
  /**
   * The machine's owner has not granted filesystem writes (019). Surfaced while
   * reviewing rather than as a refusal mid-apply: a policy the user cannot
   * change from here should never look like a failure they caused.
   */
  Type.Literal('environment-readonly'),
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
  /**
   * Machines holding these bytes. Divergence across machines reads exactly like
   * divergence across locations: there is no canonical copy, and any machine's
   * version can be the one the user picks.
   */
  environmentIds: Type.Array(LibraryEnvironmentIdSchema),
  /**
   * Machine `contentPath` is on. Load-bearing rather than decorative — the path
   * only means something on this machine, and reading it anywhere else would
   * either miss or, worse, find a different file with the same name.
   */
  contentEnvironmentId: LibraryEnvironmentIdSchema,
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
  /** Machine this location is on; a destination is the pair, never the location alone. */
  environmentId: LibraryEnvironmentIdSchema,
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
  /**
   * Machines this propagation spans, as both sources and destinations.
   *
   * Every named machine contributes its copies as candidate winners and is
   * offered as a destination for each requested location. Omitted means Local
   * alone, which is what a client that predates cross-machine propagation could
   * only have meant.
   */
  environmentIds: Type.Optional(
    Type.Array(LibraryEnvironmentIdSchema, { minItems: 1, maxItems: 16 })
  ),
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
  /** Machine the destination is on; omitted means Local. */
  environmentId: Type.Optional(LibraryEnvironmentIdSchema),
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
  environmentId: LibraryEnvironmentIdSchema,
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
  environmentId: LibraryEnvironmentIdSchema,
  locationId: Type.Optional(LibraryLocationIdSchema),
  reason: PropagationSkipReasonSchema,
});

export const PropagationFailureSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  environmentId: LibraryEnvironmentIdSchema,
  locationId: LibraryLocationIdSchema,
  reason: PropagationFailureReasonSchema,
  message: Type.String(),
});

/** One machine's backup set, and the machine it is on — the pair `undo` takes. */
export const PropagationBackupHandleSchema = Type.Object({
  environmentId: LibraryEnvironmentIdSchema,
  backupId: Type.String({ minLength: 1 }),
});

export const PropagationApplySchema = Type.Object({
  /**
   * The set on the machine this result describes. Present on a runtime's own
   * answer, and on a hub answer that wrote to exactly one machine. A propagation
   * spanning machines produces one set per machine and leaves this absent —
   * `backups` is the handle that is always complete.
   */
  backupId: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Every set this apply produced, one per machine written to.
   *
   * A cross-machine apply has no single undo: each machine backed up its own
   * files under its own root, and rolling back means asking each of them. One
   * id could only ever name one of those, which is how a user ends up believing
   * they undid something they undid half of.
   */
  backups: Type.Array(PropagationBackupHandleSchema),
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

/**
 * A backup set id supplied by a client.
 *
 * Every one of these becomes a path segment under the backup root, so the shape
 * is constrained at the edge rather than only by the store's own guard: a
 * leading dot, a slash, or a `..` must be a 422 on the way in, not a `TypeError`
 * raised deep enough that a route reports it as an internal failure.
 */
const BackupIdRequestSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]*$',
});

export const PropagationUndoRequestSchema = Type.Object({
  backupId: BackupIdRequestSchema,
  /**
   * Which machine holds the set. Omitted means Local, which is where every
   * backup written before environments existed lives — and the only place a
   * client that predates this field could have meant.
   */
  environmentId: Type.Optional(LibraryEnvironmentIdSchema),
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

/**
 * What one undo did, as the machine that performed it reports.
 *
 * Stops short of naming an environment for the same reason
 * {@link LibraryBackupSetSchema} does: the id is the hub's, not the machine's.
 */
export const LibraryUndoResultSchema = Type.Object({
  backupId: Type.String({ minLength: 1 }),
  restored: Type.Array(PropagationUndoEntrySchema),
  removed: Type.Array(PropagationUndoEntrySchema),
  skipped: Type.Array(PropagationUndoSkippedSchema),
});

/**
 * The hub's answer, which names the machine as well as the set.
 *
 * Backup ids are minted per store, so two machines can hold the same id — and a
 * client rendering a result against "the row with this backupId" would report an
 * undo on the wrong machine's row without this.
 */
export const PropagationUndoSchema = Type.Interface([LibraryUndoResultSchema], {
  environmentId: LibraryEnvironmentIdSchema,
});

/**
 * Which flow wrote a backup set, and therefore what undoing it does.
 *
 * Load-bearing rather than descriptive. Undo restores every entry that carries a
 * backup and deletes every entry that does not, so it puts content back for a
 * removal set and takes content away for a propagation set that created paths.
 * One label across both is a button that silently deletes files on half the
 * list.
 *
 * `unknown` is a set whose manifest predates the field. It is never inferred
 * from the entries: a propagation apply that only overwrote pre-existing files
 * produces entries shaped exactly like a removal's, so the heuristic is unsound
 * in precisely the case where being wrong destroys a file.
 */
export const BackupSetOperationSchema = Type.Union([
  Type.Literal('propagation'),
  Type.Literal('removal'),
  Type.Literal('unknown'),
]);

/**
 * One retained backup set as the machine holding it describes itself.
 *
 * Everything here is read off that machine's disk, which is why it stops short
 * of naming an environment: a runtime does not know the id its hub filed it
 * under, and a machine reachable from two hubs would answer with two different
 * ones. {@link PropagationBackupSetSchema} adds the hub's view on top.
 */
export const LibraryBackupSetSchema = Type.Object({
  backupId: Type.String({ minLength: 1 }),
  createdAtMs: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  entryCount: Type.Integer({ minimum: 0 }),
  /**
   * True when the set holds the last remaining copy of a resource. Retention
   * never evicts one: the alternative is deleting a user's only copy of
   * something to reclaim disk, which is not a trade the app gets to make.
   */
  pinned: Type.Boolean(),
  /** Resources whose final instance this set is the only remaining copy of. */
  lastCopyResourceKeys: Type.Array(Type.String({ minLength: 1 })),
  operation: BackupSetOperationSchema,
  /**
   * Every resource the set holds, deduped and sorted, so a row can say what is
   * in it. Empty for a manifest written before entries carried a resource key —
   * a slug alone does not identify a resource.
   */
  resourceKeys: Type.Array(Type.String({ minLength: 1 })),
  /**
   * True when the next prune would evict this set, so retention stops being
   * something a user discovers after the fact. Never true for a pinned set, at
   * any budget.
   */
  evictsNext: Type.Boolean(),
  /**
   * False when the set directory is there but its manifest is missing or
   * unparseable. Reported rather than hidden: the bytes still cost disk and can
   * still be purged, but nothing can be restored from them, and a row that
   * offers Undo anyway is a button that fails on click.
   */
  manifestReadable: Type.Boolean(),
});

/**
 * Whether a listed backup set can be restored right now, and if not, why.
 *
 * A code rather than a boolean because the two failures need different copy and
 * different fixes: an offline machine is a "connect it and try again", while a
 * lost manifest is permanent and the only remaining action is purge. Both are
 * rendered as a disabled action with a reason — never as an error on click,
 * which is the shape that teaches users their backups are unreliable.
 */
export const BackupAvailabilitySchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('environment-offline'),
  Type.Literal('manifest-missing'),
]);

/**
 * One retained backup set, as the hub lists it.
 *
 * Backups live on the machine that owned the file (006's one exception to
 * "runtime holds no durable user data"), so a listing that reads manifests can
 * only enumerate machines it can reach — and an offline environment's backups
 * would silently vanish from the page that promises them. The hub-side index is
 * what makes the row survive the machine being away; `availability` is what
 * keeps the row honest about what can be done with it.
 */
export const PropagationBackupSetSchema = Type.Interface([LibraryBackupSetSchema], {
  environmentId: LibraryEnvironmentIdSchema,
  availability: BackupAvailabilitySchema,
});

/**
 * What retained backups currently cost. Surfaced so a directory holding copies
 * of skill trees is never a mystery disk consumer the user has to discover.
 *
 * Retention bounds are hub policy and apply to **each** environment's store
 * rather than to their sum: the bytes sit on different disks, and one machine
 * filling the budget must never evict another machine's history.
 */
export const PropagationBackupUsageSchema = Type.Object({
  setCount: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  retentionCount: Type.Integer({ minimum: 1 }),
  retentionBytes: Type.Integer({ minimum: 1 }),
  /** Bytes held by pinned sets, which count against the budget but never evict. */
  pinnedSizeBytes: Type.Integer({ minimum: 0 }),
  sets: Type.Array(PropagationBackupSetSchema),
  /**
   * Environments whose store could not be read on this request, so the rows
   * they contributed came from the index alone. Named so the page can say which
   * machine it is out of touch with instead of quietly under-reporting bytes.
   */
  unreachableEnvironmentIds: Type.Array(LibraryEnvironmentIdSchema),
});

export const PropagationBackupPurgeRequestSchema = Type.Object({
  backupId: BackupIdRequestSchema,
});

/**
 * Purge names the machine as well as the set.
 *
 * Backup ids are minted per store, so the same id can exist on two machines,
 * and a purge that only names the id would delete whichever one the hub
 * happened to look at first.
 */
export const PropagationBackupPurgeQuerySchema = Type.Object({
  environmentId: Type.Optional(LibraryEnvironmentIdSchema),
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

/**
 * What removing one resource from one location would do.
 *
 * Deliberately not an `operation: 'delete'` flag on propagation. Propagation
 * asks *which content wins*; removal asks *which copies go*, and a single
 * wizard meaning both is one where the destructive path shares a confirm button
 * with the safe one.
 */
export const RemovalOperationSchema = Type.Union([
  Type.Literal('remove'),
  /** No instance here. Shown rather than hidden, the same way propagation shows `noop`. */
  Type.Literal('absent'),
  Type.Literal('blocked'),
]);

export const RemovalBlockedReasonSchema = Type.Union([
  Type.Literal('read-only-location'),
  Type.Literal('unsupported-location'),
  Type.Literal('location-unwritable'),
  /** Same machine-level reasons propagation reports; see `PropagationBlockedReasonSchema`. */
  Type.Literal('environment-offline'),
  Type.Literal('environment-unsupported'),
  Type.Literal('environment-readonly'),
  /**
   * The scanner could not read this instance end to end. An instance that
   * cannot be backed up faithfully cannot be undone, and a removal whose undo
   * is best-effort is worse than no removal — so it blocks rather than removes.
   */
  Type.Literal('invalid-instance'),
]);

export const RemovalLocationSchema = Type.Object({
  /** Machine this copy is on; a copy is the pair, never the location alone. */
  environmentId: LibraryEnvironmentIdSchema,
  locationId: LibraryLocationIdSchema,
  /** Every target that would stop seeing the resource if this copy goes. */
  targetIds: Type.Array(LibraryTargetIdSchema),
  operation: RemovalOperationSchema,
  /** Absolute path of the copy here; null when there is no instance to remove. */
  path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  /**
   * Hash of the copy here, which is also its content-group identity: two
   * locations hold the same version exactly when these match.
   */
  contentHash: Type.Optional(Type.String({ minLength: 1 })),
  modifiedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * True when removing this instance takes the last copy of its version with
   * it. Not a block and not an extra confirmation — resolving a divergence by
   * deleting the copy you do not want is legitimate, and arguably the most
   * common resolution. The user only needs to know which of the two they are doing.
   */
  eliminatesContentGroup: Type.Boolean(),
  blockedReason: Type.Optional(RemovalBlockedReasonSchema),
});

export const RemovalPreviewEntrySchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  ref: LibraryResourceRefSchema,
  divergence: LibraryDivergenceSchema,
  locations: Type.Array(RemovalLocationSchema),
  /**
   * Every copy that exists, on every machine in scope — including ones this
   * preview does not offer to remove.
   *
   * The last-copy guard is decided against this list rather than against the
   * offered rows: a resource is only zeroed when nothing is left *anywhere*,
   * and a preview scoped to two of its four homes must not be able to claim it.
   * Machine-qualified for the same reason, one dimension out: a copy surviving
   * on another box is still a surviving copy, and a guard that counted only
   * locations would demand an acknowledgement for a resource that is not
   * actually about to disappear.
   */
  instancePlacements: Type.Array(
    Type.Object({
      environmentId: LibraryEnvironmentIdSchema,
      locationId: LibraryLocationIdSchema,
    })
  ),
  /** True when removing every removable location shown would leave no instance anywhere. */
  wouldRemoveLastCopy: Type.Boolean(),
});

/**
 * A staged-removal directory an interrupted apply left behind. Reported rather
 * than deleted on sight: a stale temp tree beside a destination is the accepted
 * cost of never leaving a half-removed skill, and quietly deleting one would
 * discard the only copy of whatever the interrupted apply was holding.
 */
/** A leftover as the machine holding it describes itself — no environment id. */
export const LibraryStagedRemovalSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  path: Type.String({ minLength: 1 }),
  modifiedAtMs: Type.Integer({ minimum: 0 }),
});

/** The hub's view, which names the machine the stale directory is sitting on. */
export const StagedRemovalLeftoverSchema = Type.Interface([LibraryStagedRemovalSchema], {
  environmentId: LibraryEnvironmentIdSchema,
});

export const RemovalPreviewRequestSchema = Type.Object({
  resourceKeys: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: PROPAGATION_PREVIEW_MAX_RESOURCES,
  }),
  locationIds: Type.Array(LibraryLocationIdSchema, { minItems: 1, maxItems: 64 }),
  /**
   * Machines whose copies are in scope. Omitted means Local. Every named machine
   * is offered as a place to remove from *and* counted by the last-copy guard —
   * the two cannot be separated without the guard lying.
   */
  environmentIds: Type.Optional(
    Type.Array(LibraryEnvironmentIdSchema, { minItems: 1, maxItems: 16 })
  ),
  /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
  profileId: Type.Optional(ProfileIdSchema),
});

export const RemovalPreviewSchema = Type.Object({
  previewToken: Type.String({ minLength: 1 }),
  /**
   * Covers the same ground it does in propagation and matters more here:
   * between preview and apply the user may have edited the very copy they are
   * about to delete, and a rejected apply is the only thing standing between
   * that edit and its disappearance.
   */
  stateHash: Type.String({ minLength: 1 }),
  entries: Type.Array(RemovalPreviewEntrySchema),
  staleStagedRemovals: Type.Array(StagedRemovalLeftoverSchema),
});

export const RemovalLocationDecisionSchema = Type.Object({
  /** Machine the copy is on; omitted means Local. */
  environmentId: Type.Optional(LibraryEnvironmentIdSchema),
  locationId: LibraryLocationIdSchema,
  action: Type.Union([Type.Literal('remove'), Type.Literal('keep')]),
});

export const RemovalDecisionSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  /** Every location the preview offered, each explicitly removed or kept. */
  locations: Type.Array(RemovalLocationDecisionSchema),
});

export const RemovalApplyRequestSchema = Type.Object({
  previewToken: Type.String({ minLength: 1 }),
  stateHash: Type.String({ minLength: 1 }),
  /** The preview request this apply answers, so the token can be re-derived. */
  request: RemovalPreviewRequestSchema,
  decisions: Type.Array(RemovalDecisionSchema, {
    minItems: 1,
    maxItems: PROPAGATION_PREVIEW_MAX_RESOURCES,
  }),
  /**
   * Resource keys whose final instance the user has explicitly acknowledged.
   *
   * A separate field rather than a per-location flag on purpose: a client must
   * not be able to satisfy it by looping over locations. Removing your only
   * copy of a skill you wrote is recoverable only through the backup, and only
   * while it is retained — a different category of action from removing a
   * duplicate, and the contract says so.
   */
  acknowledgeLastCopy: Type.Array(Type.String({ minLength: 1 }), {
    maxItems: PROPAGATION_PREVIEW_MAX_RESOURCES,
  }),
  /** Reserved: profiles are not selectable yet. Omitted requests use the active profile. */
  profileId: Type.Optional(ProfileIdSchema),
});

/**
 * Why a copy the preview offered is still on disk.
 *
 * Every location the user reviewed lands in exactly one of `removed`, `kept`, or
 * `failed`. The last two reasons exist to keep that total: an apply stops at its
 * first failure, and the copies it never reached — or already put back — would
 * otherwise be reported nowhere at all.
 */
export const RemovalKeptReasonSchema = Type.Union([
  Type.Literal('user-kept'),
  Type.Literal('absent'),
  Type.Literal('blocked'),
  /** The apply stopped at an earlier failure and never reached this copy. */
  Type.Literal('not-attempted'),
  /** Staged aside, then restored when a later failure compensated the apply. */
  Type.Literal('rolled-back'),
]);

export const RemovalFailureReasonSchema = Type.Union([
  Type.Literal('guard-rejected'),
  Type.Literal('backup-failed'),
  Type.Literal('remove-failed'),
  /** The destination still existed after the unlink, so nothing is proven removed. */
  Type.Literal('verification-failed'),
]);

export const RemovalRemovedSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  environmentId: LibraryEnvironmentIdSchema,
  locationId: LibraryLocationIdSchema,
  path: Type.String({ minLength: 1 }),
  /** Hash of what was removed, re-read from disk rather than taken from the preview. */
  contentHash: Type.String({ minLength: 1 }),
  /** True when this removal took the resource's final remaining instance. */
  lastCopy: Type.Boolean(),
});

export const RemovalKeptSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  environmentId: LibraryEnvironmentIdSchema,
  locationId: LibraryLocationIdSchema,
  reason: RemovalKeptReasonSchema,
});

export const RemovalFailureSchema = Type.Object({
  resourceKey: Type.String({ minLength: 1 }),
  environmentId: LibraryEnvironmentIdSchema,
  locationId: LibraryLocationIdSchema,
  reason: RemovalFailureReasonSchema,
  message: Type.String(),
});

export const RemovalApplySchema = Type.Object({
  /**
   * The set on the machine this result describes. Shares propagation's backup
   * namespace, so `POST /library/propagate/undo` restores either kind of apply.
   * Absent when the removal spanned machines — see `backups`.
   */
  backupId: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Every set this removal produced, one per machine it took copies from.
   *
   * A removal's backup is the only remaining copy of what it deleted, so a
   * cross-machine removal has one irreplaceable set per machine. Naming only
   * one of them is how a user restores half of what they lost and believes
   * they restored all of it.
   */
  backups: Type.Array(PropagationBackupHandleSchema),
  /**
   * False when the filesystem matches its pre-apply state — everything landed,
   * or a failure was fully compensated. True is the alarming case: a failure
   * whose compensation also failed, leaving some copies already gone.
   */
  partial: Type.Boolean(),
  removed: Type.Array(RemovalRemovedSchema),
  kept: Type.Array(RemovalKeptSchema),
  failed: Type.Array(RemovalFailureSchema),
});

export type ResourceKind = Static<typeof ResourceKindSchema>;
export type LibraryTargetId = Static<typeof LibraryTargetIdSchema>;
export type LibraryLocationId = Static<typeof LibraryLocationIdSchema>;
export type LibraryScope = Static<typeof LibraryScopeSchema>;
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
export type LibraryUnreadableEntryReason = Static<typeof LibraryUnreadableEntryReasonSchema>;
export type LibraryUnreadableEntry = Static<typeof LibraryUnreadableEntrySchema>;
export type LibraryScanResult = Static<typeof LibraryScanResultSchema>;
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
export type PropagationBackupHandle = Static<typeof PropagationBackupHandleSchema>;
export type PropagationApply = Static<typeof PropagationApplySchema>;
export type PropagationUndoRequest = Static<typeof PropagationUndoRequestSchema>;
export type LibraryUndoResult = Static<typeof LibraryUndoResultSchema>;
export type PropagationUndo = Static<typeof PropagationUndoSchema>;
export type BackupSetOperation = Static<typeof BackupSetOperationSchema>;
export type LibraryBackupSet = Static<typeof LibraryBackupSetSchema>;
export type BackupAvailability = Static<typeof BackupAvailabilitySchema>;
export type PropagationBackupSet = Static<typeof PropagationBackupSetSchema>;
export type PropagationBackupUsage = Static<typeof PropagationBackupUsageSchema>;
export type RemovalOperation = Static<typeof RemovalOperationSchema>;
export type RemovalBlockedReason = Static<typeof RemovalBlockedReasonSchema>;
export type RemovalLocation = Static<typeof RemovalLocationSchema>;
export type RemovalPreviewEntry = Static<typeof RemovalPreviewEntrySchema>;
export type LibraryStagedRemoval = Static<typeof LibraryStagedRemovalSchema>;
export type StagedRemovalLeftover = Static<typeof StagedRemovalLeftoverSchema>;
export type RemovalPreviewRequest = Static<typeof RemovalPreviewRequestSchema>;
export type RemovalPreview = Static<typeof RemovalPreviewSchema>;
export type RemovalLocationDecision = Static<typeof RemovalLocationDecisionSchema>;
export type RemovalDecision = Static<typeof RemovalDecisionSchema>;
export type RemovalApplyRequest = Static<typeof RemovalApplyRequestSchema>;
export type RemovalKeptReason = Static<typeof RemovalKeptReasonSchema>;
export type RemovalFailureReason = Static<typeof RemovalFailureReasonSchema>;
export type RemovalRemoved = Static<typeof RemovalRemovedSchema>;
export type RemovalKept = Static<typeof RemovalKeptSchema>;
export type RemovalFailure = Static<typeof RemovalFailureSchema>;
export type RemovalApply = Static<typeof RemovalApplySchema>;
export type LibraryDivergenceAck = Static<typeof LibraryDivergenceAckSchema>;
export type LibraryDivergenceAckRequest = Static<typeof LibraryDivergenceAckRequestSchema>;

export const SKILL_SOURCE_TO_LOCATION_ID: Record<SkillSource, LibraryLocationId> = {
  mango: 'mango-skills',
  agents: 'agents-skills',
  claude: 'claude-skills',
};
