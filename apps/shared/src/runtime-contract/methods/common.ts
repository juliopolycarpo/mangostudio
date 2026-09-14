/**
 * The pieces more than one method family is built from: the snapshot shapes a
 * mutating filesystem call records, and the parameter base every one of them
 * extends.
 *
 * Schema-first, like the families that import it — the schema is the source and
 * the type is `Static<>` of it. The one exception is documented where it sits.
 */

import Type, { type Static, type TSchema } from 'typebox';
import { ReadonlyArraySchema } from '../../schema-helpers';
import { RuntimePathPolicyParamsSchema } from '../path-policy';

/** `afterHash` of a path that does not exist, so "absent" is a value like any other. */
export const RUNTIME_ABSENT_HASH = 'absent';

/**
 * A method that takes nothing.
 *
 * Still an object rather than nothing at all: the protocol's `req` frame
 * requires `params`, and an empty object is the shape a later release adds an
 * optional member to without becoming a new method.
 */
export const RuntimeNoParamsSchema = Type.Object({});
export type RuntimeNoParams = Static<typeof RuntimeNoParamsSchema>;

/**
 * A method that answers "done" and nothing else.
 *
 * `ok` is a literal rather than a boolean because there is no false: a method
 * that did not do the thing refuses with an error, so a payload carrying
 * `ok: false` would be a peer that has misunderstood the contract.
 */
export const RuntimeAckResultSchema = Type.Object({ ok: Type.Literal(true) });
export type RuntimeAckResult = Static<typeof RuntimeAckResultSchema>;

export type {
  ExternalAgentAckResult,
  ExternalAgentCancelParams,
  ExternalAgentCloseParams,
  ExternalAgentDiscoverParams,
  ExternalAgentDiscoverResult,
  ExternalAgentEventEnvelope,
  ExternalAgentListSessionsParams,
  ExternalAgentListSessionsResult,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRefreshAccountUsageParams,
  ExternalAgentRefreshAccountUsageResult,
  ExternalAgentRespondParams,
  ExternalAgentStartReviewParams,
  ExternalAgentStartReviewResult,
  ExternalAgentSteerParams,
  ExternalAgentSteerResult,
  ExternalAgentTurnParams,
  ExternalAgentTurnResult,
} from '../../external-agents';

/** What a path held before a mutation touched it, when the call asked for a snapshot. */
export const RuntimeBeforeSnapshotSchema = Type.Object({
  exists: Type.Boolean(),
  contentBase64: Type.Optional(Type.String()),
  hash: Type.Optional(Type.String()),
});
export type RuntimeBeforeSnapshot = Static<typeof RuntimeBeforeSnapshotSchema>;

export const RuntimeMutationSnapshotSchema = Type.Object({
  path: Type.String(),
  op: Type.Union([
    Type.Literal('create'),
    Type.Literal('delete'),
    Type.Literal('edit'),
    Type.Literal('move'),
  ]),
  movedTo: Type.Optional(Type.String()),
  before: RuntimeBeforeSnapshotSchema,
  /** {@link RUNTIME_ABSENT_HASH} when the path no longer exists. */
  afterHash: Type.String(),
});
export type RuntimeMutationSnapshot = Static<typeof RuntimeMutationSnapshotSchema>;

/**
 * A mutating filesystem result paired with the snapshots the checkpoint ledger
 * needs, over whichever result shape the method itself returns.
 *
 * @example
 * const schema = RuntimeMutationResultSchema(RuntimeWriteFileResultSchema);
 */
export function RuntimeMutationResultSchema<T extends TSchema>(result: T) {
  return Type.Object({
    result,
    mutations: ReadonlyArraySchema(RuntimeMutationSnapshotSchema),
  });
}

/**
 * The one shape in this directory that is not `Static<>` of a schema.
 *
 * It is generic over the *value* a method returns, and TypeScript has no way to
 * express `Static<>` of a schema factory without applying it first. Callers
 * name it with a result type (`RuntimeMutationResult<RuntimeWriteFileResult>`),
 * not with a schema, so the alias is what they can actually use. The schema
 * half is {@link RuntimeMutationResultSchema} and the two are kept in step by
 * the contract, which builds every mutating method's result from the factory.
 */
export interface RuntimeMutationResult<T> {
  readonly result: T;
  readonly mutations: readonly RuntimeMutationSnapshot[];
}

/** Parameter base of every mutating filesystem method. */
export const RuntimeMutationParamsSchema = Type.Interface([RuntimePathPolicyParamsSchema], {
  chatId: Type.String(),
  captureSnapshot: Type.Boolean(),
});
