/**
 * The probing family: the hub asking a runtime what runtimes, version
 * managers, and agent CLIs it can see on its host.
 *
 * Schema-first, like the families that import it — the schema is the source
 * and the type is `Static<>` of it.
 */

import Type, { type Static } from 'typebox';
import {
  AgentCliStatusSchema,
  ConsumerVersionRequirementSchema,
  MinimumRuntimeVersionSchema,
  RuntimeIdSchema,
  RuntimeStatusSchema,
  VersionManagerIdSchema,
  VersionManagerStatusSchema,
} from '../../environments/schemas';
import { LibraryTargetIdSchema } from '../../library/schemas';
import { ReadonlyArraySchema, ReadonlyRecordSchema } from '../../schema-helpers';

/**
 * Bounds a probe's spawns on the machine that runs them. The budget belongs
 * with the spawns rather than on the hub, where a timer would only be racing
 * the transport; the hub's own `timeoutMs` sits above these values so a dead
 * link and an over-running probe are still distinguishable.
 */
export const RuntimeProbeBudgetSchema = Type.Object({
  probeTimeoutMs: Type.Optional(Type.Number()),
  totalTimeoutMs: Type.Optional(Type.Number()),
  maxConcurrency: Type.Optional(Type.Number()),
});
export type RuntimeProbeBudget = Static<typeof RuntimeProbeBudgetSchema>;

/** Parameter base every probe method extends. */
export const RuntimeProbeParamsSchema = Type.Object({
  budget: Type.Optional(RuntimeProbeBudgetSchema),
  /**
   * Variables merged over this host's own environment. The hub pins the
   * MangoStudio library directories here for its own machine — they are
   * product configuration, not a property of a host — and pins nothing for
   * anyone else's, where its paths would name nothing.
   */
  pathEnv: Type.Optional(
    Type.Object({
      env: Type.Optional(ReadonlyRecordSchema(Type.String())),
    })
  ),
});

export const RuntimeProbeRuntimesParamsSchema = Type.Interface([RuntimeProbeParamsSchema], {
  ids: Type.Optional(ReadonlyArraySchema(RuntimeIdSchema)),
  /** Hub policy: which ids this release can offer an install recipe for. */
  installable: Type.Optional(Type.Partial(Type.Record(RuntimeIdSchema, Type.Boolean()))),
  minimumVersions: Type.Optional(
    Type.Partial(Type.Record(RuntimeIdSchema, MinimumRuntimeVersionSchema))
  ),
  /** Per-consumer floors — a feature that needs a newer runtime than the generic minimum. */
  consumerMinimumVersions: Type.Optional(
    Type.Partial(
      Type.Record(RuntimeIdSchema, ReadonlyArraySchema(ConsumerVersionRequirementSchema))
    )
  ),
});
export type RuntimeProbeRuntimesParams = Static<typeof RuntimeProbeRuntimesParamsSchema>;

export const RuntimeProbeRuntimesResultSchema = Type.Object({
  statuses: ReadonlyArraySchema(RuntimeStatusSchema),
});
export type RuntimeProbeRuntimesResult = Static<typeof RuntimeProbeRuntimesResultSchema>;

export const RuntimeProbeVersionManagersParamsSchema = Type.Interface([RuntimeProbeParamsSchema], {
  ids: Type.Optional(ReadonlyArraySchema(VersionManagerIdSchema)),
  /**
   * Latest published patch per major, keyed by major as a string because a
   * JSON object cannot key on a number. The hub fetches it: reaching the
   * network is its policy, and a runtime on a locked-down host may have none.
   */
  latestByMajor: Type.Optional(ReadonlyRecordSchema(Type.String())),
});
export type RuntimeProbeVersionManagersParams = Static<
  typeof RuntimeProbeVersionManagersParamsSchema
>;

export const RuntimeProbeVersionManagersResultSchema = Type.Object({
  statuses: ReadonlyArraySchema(VersionManagerStatusSchema),
});
export type RuntimeProbeVersionManagersResult = Static<
  typeof RuntimeProbeVersionManagersResultSchema
>;

export const RuntimeProbeAgentClisParamsSchema = Type.Interface([RuntimeProbeParamsSchema], {
  targetIds: Type.Optional(ReadonlyArraySchema(LibraryTargetIdSchema)),
  installable: Type.Optional(Type.Partial(Type.Record(LibraryTargetIdSchema, Type.Boolean()))),
  /**
   * What the hub is, for the `mangostudio` target. `configHome` and
   * `executablePath` are sent only when this host *is* the hub's machine;
   * elsewhere the runtime answers with its own, which is the honest reading of
   * "what MangoStudio looks like over there".
   */
  self: Type.Object({
    version: Type.String(),
    configHome: Type.Optional(Type.String()),
    executablePath: Type.Optional(Type.String()),
  }),
});
export type RuntimeProbeAgentClisParams = Static<typeof RuntimeProbeAgentClisParamsSchema>;

export const RuntimeProbeAgentClisResultSchema = Type.Object({
  statuses: ReadonlyArraySchema(AgentCliStatusSchema),
});
export type RuntimeProbeAgentClisResult = Static<typeof RuntimeProbeAgentClisResultSchema>;
