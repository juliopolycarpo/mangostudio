/**
 * The library family: scanning, reading and writing agent-home resources on
 * this host, plus the backup store that write and remove leave behind.
 *
 * Schema-first, like the other families in this directory — the schema is the
 * source and the type is `Static<>` of it, with one seam. The write shapes
 * (`RuntimeLibraryApplyOperation`, `RuntimeLibraryRemoveOperation`, …) are the
 * engines' own shapes from `../../library/write-shapes`, encoded: the engine
 * carries a resource's bytes as `Uint8Array`, the wire carries them as base64,
 * and only that difference is declared twice.
 */

import Type, { type Static } from 'typebox';
import { LibraryLocationSettingsSchema } from '../../app-settings/schemas';
import {
  LibraryBackupSetSchema,
  LibraryInstanceSchema,
  LibraryLocationIdSchema,
  LibraryLocationStatusSchema,
  LibraryResourceRefSchema,
  LibraryUndoResultSchema,
  LibraryUnreadableEntrySchema,
  PropagationApplySchema,
  RemovalApplySchema,
  ResourceKindSchema,
} from '../../library/schemas';
import {
  PreparedPropagationAdaptationSchema,
  PreparedPropagationOperationBaseSchema,
  PreparedRemovalOperationSchema,
} from '../../library/write-shapes';
import { ReadonlyArraySchema, ReadonlyRecordSchema } from '../../schema-helpers';

/**
 * Variables merged over this host's own environment for library path
 * resolution. The hub pins configured MangoStudio directories here for its own
 * machine and pins nothing for anyone else's.
 */
export const RuntimeLibraryPathEnvParamsSchema = Type.Object({
  env: Type.Optional(ReadonlyRecordSchema(Type.String())),
  workspaceRoot: Type.Optional(Type.String()),
});
export type RuntimeLibraryPathEnvParams = Static<typeof RuntimeLibraryPathEnvParamsSchema>;

export const RuntimeLibraryScanParamsSchema = Type.Object({
  /**
   * Enabled/disabled map per scope. The hub resolves the user's settings; this
   * host only needs the boolean map to know which locations to open.
   */
  locationSettings: LibraryLocationSettingsSchema,
  force: Type.Optional(Type.Boolean()),
  kinds: Type.Optional(ReadonlyArraySchema(ResourceKindSchema)),
  locationPathOverrides: Type.Optional(
    // Not `ReadonlyRecordSchema`: a value may be absent per key (the hub only
    // overrides the locations it needs to), and callers build this as a
    // `Partial` record. `Type.Record` cannot express an optional value, so this
    // is unsafe-cast the same way `ReadonlyRecordSchema` casts its own shape.
    Type.Unsafe<Readonly<Partial<Record<string, string>>>>(
      Type.Record(Type.String(), Type.String())
    )
  ),
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
});
export type RuntimeLibraryScanParams = Static<typeof RuntimeLibraryScanParamsSchema>;

export const RuntimeLibraryScanEntrySchema = Type.Object({
  ref: LibraryResourceRefSchema,
  instance: LibraryInstanceSchema,
  whitespaceHash: Type.Optional(Type.String()),
});
export type RuntimeLibraryScanEntry = Static<typeof RuntimeLibraryScanEntrySchema>;

export const RuntimeLibraryScanResultSchema = Type.Object({
  entries: ReadonlyArraySchema(RuntimeLibraryScanEntrySchema),
  unreadableEntries: ReadonlyArraySchema(LibraryUnreadableEntrySchema),
});
export type RuntimeLibraryScanResult = Static<typeof RuntimeLibraryScanResultSchema>;

export const RuntimeLibraryReadParamsSchema = Type.Object({
  path: Type.String(),
  /**
   * Location the scan found this instance in. The root that contains the read
   * is resolved here, from this host's own `PathEnv` — the hub names *which*
   * location, never where it is. A hub-supplied root would be a guess about
   * someone else's filesystem, and a root derived from the instance path
   * contains that path by construction, which is no containment at all.
   */
  locationId: LibraryLocationIdSchema,
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
  maxBytes: Type.Optional(Type.Number()),
  truncateOversize: Type.Optional(Type.Boolean()),
});
export type RuntimeLibraryReadParams = Static<typeof RuntimeLibraryReadParamsSchema>;

export const RuntimeLibraryReadResultSchema = Type.Object({
  content: Type.String(),
  truncated: Type.Boolean(),
  sizeBytes: Type.Number(),
  /** Set when the path is outside the location root or otherwise refused. */
  denied: Type.Optional(Type.Literal(true)),
  reason: Type.Optional(Type.String()),
});
export type RuntimeLibraryReadResult = Static<typeof RuntimeLibraryReadResultSchema>;

/**
 * Reads a whole directory resource so it can be written on another machine.
 *
 * `library.read` answers with one file's text for the detail view; a skill is a
 * tree, and the destination's `library.apply` cannot reach a source directory
 * that lives on a different host. The bytes travel base64 in the frame, bounded
 * by the same caps a scan enforces.
 */
export const RuntimeLibraryReadTreeParamsSchema = Type.Object({
  /** Absolute directory path on this host, as the scan reported it. */
  path: Type.String(),
  locationId: LibraryLocationIdSchema,
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
});
export type RuntimeLibraryReadTreeParams = Static<typeof RuntimeLibraryReadTreeParamsSchema>;

export const RuntimeLibraryTreeFileSchema = Type.Object({
  /** Posix-separated path relative to the resource root. */
  relativePath: Type.String(),
  contentBase64: Type.String(),
});
export type RuntimeLibraryTreeFile = Static<typeof RuntimeLibraryTreeFileSchema>;

export const RuntimeLibraryReadTreeResultSchema = Type.Object({
  files: ReadonlyArraySchema(RuntimeLibraryTreeFileSchema),
  /** Set when the path is outside the location root or otherwise refused. */
  denied: Type.Optional(Type.Literal(true)),
  reason: Type.Optional(Type.String()),
});
export type RuntimeLibraryReadTreeResult = Static<typeof RuntimeLibraryReadTreeResultSchema>;

export const RuntimeLibraryLocationsParamsSchema = Type.Object({
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
});
export type RuntimeLibraryLocationsParams = Static<typeof RuntimeLibraryLocationsParamsSchema>;

export const RuntimeLibraryLocationsResultSchema = Type.Object({
  locations: ReadonlyArraySchema(LibraryLocationStatusSchema),
});
export type RuntimeLibraryLocationsResult = Static<typeof RuntimeLibraryLocationsResultSchema>;

export const RuntimeLibrarySettingsSourcesParamsSchema = Type.Object({
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
});
export type RuntimeLibrarySettingsSourcesParams = Static<
  typeof RuntimeLibrarySettingsSourcesParamsSchema
>;

export const RuntimeLibraryBackupEnvelopeSchema = Type.Object({
  /** Absolute backup root on this host. Hub-supplied; never invented here. */
  backupRoot: Type.String(),
  retentionCount: Type.Optional(Type.Number()),
  retentionBytes: Type.Optional(Type.Number()),
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
  backupId: Type.Optional(Type.String()),
  /**
   * Which environment the hub is writing to, echoed back on every result row
   * and stamped into the backup manifest.
   *
   * The id is a hub concept — this host has no way to know what it was filed
   * under — so it travels with the request rather than being resolved here.
   * Absent means Local, which is what every backup written before environments
   * existed was.
   */
  environmentId: Type.Optional(Type.String()),
});
export type RuntimeLibraryBackupEnvelope = Static<typeof RuntimeLibraryBackupEnvelopeSchema>;

/**
 * The write operations are the engines' own shapes, encoded.
 *
 * Declaring them twice — once here for the wire, once in the engine — meant
 * every crossing needed a cast, and a field added to one half compiled cleanly
 * while being dropped in transit. The engine module owns the shape because it
 * is the thing that acts on it; the only wire-specific difference is that bytes
 * travel as a key into `contents` rather than as a buffer.
 */
export const RuntimeLibraryApplyAdaptationSchema = PreparedPropagationAdaptationSchema;
export type RuntimeLibraryApplyAdaptation = Static<typeof RuntimeLibraryApplyAdaptationSchema>;

export const RuntimeLibraryApplyOperationSchema = Type.Interface(
  [PreparedPropagationOperationBaseSchema],
  {
    /** Key into `RuntimeLibraryApplyParams.contents`. Absent for directories. */
    contentRef: Type.Optional(Type.String()),
    /**
     * A transferred directory tree, each file naming its payload in `contents`.
     *
     * Present only when the source lives on another machine — a same-machine
     * directory apply keeps naming `sourceDir`, so nothing about that path
     * changed. Sharing the `contents` map means a skill fanned out to several
     * destinations carries its files once, exactly as file resources do.
     */
    files: Type.Optional(
      ReadonlyArraySchema(
        Type.Object({
          relativePath: Type.String(),
          contentRef: Type.String(),
        })
      )
    ),
  }
);
export type RuntimeLibraryApplyOperation = Static<typeof RuntimeLibraryApplyOperationSchema>;

export const RuntimeLibraryApplyParamsSchema = Type.Interface(
  [RuntimeLibraryBackupEnvelopeSchema],
  {
    operations: ReadonlyArraySchema(RuntimeLibraryApplyOperationSchema),
    /**
     * Base64 payloads keyed by content hash, referenced by `contentRef`.
     *
     * Shared rather than inlined per operation because propagation fans one
     * resource out across destinations: N destinations of the same bytes used to
     * put N base64 copies in a single frame, and two 2 MiB resources across five
     * locations already exceeded `DEFAULT_MAX_FRAME_BYTES`.
     */
    contents: Type.Optional(ReadonlyRecordSchema(Type.String())),
  }
);
export type RuntimeLibraryApplyParams = Static<typeof RuntimeLibraryApplyParamsSchema>;

export const RuntimeLibraryApplyResultSchema = PropagationApplySchema;
export type RuntimeLibraryApplyResult = Static<typeof RuntimeLibraryApplyResultSchema>;

export const RuntimeLibraryRemoveOperationSchema = PreparedRemovalOperationSchema;
export type RuntimeLibraryRemoveOperation = Static<typeof RuntimeLibraryRemoveOperationSchema>;

export const RuntimeLibraryRemoveParamsSchema = Type.Interface(
  [RuntimeLibraryBackupEnvelopeSchema],
  {
    operations: ReadonlyArraySchema(RuntimeLibraryRemoveOperationSchema),
    lastCopyResourceKeys: Type.Optional(ReadonlyArraySchema(Type.String())),
  }
);
export type RuntimeLibraryRemoveParams = Static<typeof RuntimeLibraryRemoveParamsSchema>;

export const RuntimeLibraryRemoveResultSchema = RemovalApplySchema;
export type RuntimeLibraryRemoveResult = Static<typeof RuntimeLibraryRemoveResultSchema>;

/**
 * Reads this host's backup store. No bounds are enforced — the retention values
 * only decide which sets `evictsNext` marks, so a listing never costs the user a
 * backup it did not warn about first.
 */
export const RuntimeLibraryBackupsParamsSchema = Type.Object({
  backupRoot: Type.String(),
  retentionCount: Type.Optional(Type.Number()),
  retentionBytes: Type.Optional(Type.Number()),
});
export type RuntimeLibraryBackupsParams = Static<typeof RuntimeLibraryBackupsParamsSchema>;

export const RuntimeLibraryBackupsResultSchema = Type.Object({
  sets: ReadonlyArraySchema(LibraryBackupSetSchema),
});
export type RuntimeLibraryBackupsResult = Static<typeof RuntimeLibraryBackupsResultSchema>;

/**
 * Deletes named sets and trims the store to its bounds, on the machine holding
 * the bytes.
 *
 * Separate from `library.backups` because it is a write: the consent gate has
 * to be able to refuse it on a readonly machine while still letting that
 * machine's history be listed.
 */
export const RuntimeLibraryGcParamsSchema = Type.Object({
  backupRoot: Type.String(),
  retentionCount: Type.Optional(Type.Number()),
  retentionBytes: Type.Optional(Type.Number()),
  /** Sets the user asked to delete by name. Purging a missing set is not an error. */
  purgeBackupIds: Type.Optional(ReadonlyArraySchema(Type.String())),
});
export type RuntimeLibraryGcParams = Static<typeof RuntimeLibraryGcParamsSchema>;

export const RuntimeLibraryGcResultSchema = Type.Object({
  purged: ReadonlyArraySchema(Type.String()),
  /** Sets retention took, so the hub can drop their index rows in the same pass. */
  pruned: ReadonlyArraySchema(Type.String()),
});
export type RuntimeLibraryGcResult = Static<typeof RuntimeLibraryGcResultSchema>;

export const RuntimeLibraryUndoParamsSchema = Type.Object({
  backupRoot: Type.String(),
  backupId: Type.String(),
  /**
   * Resolves the registry roots the manifest's paths have to sit inside. No
   * retention bounds travel: undo restores and removes, it never prunes.
   */
  pathEnv: Type.Optional(RuntimeLibraryPathEnvParamsSchema),
});
export type RuntimeLibraryUndoParams = Static<typeof RuntimeLibraryUndoParamsSchema>;

export const RuntimeLibraryUndoResultSchema = LibraryUndoResultSchema;
export type RuntimeLibraryUndoResult = Static<typeof RuntimeLibraryUndoResultSchema>;
