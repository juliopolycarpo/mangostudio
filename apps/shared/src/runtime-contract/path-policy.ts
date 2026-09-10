/**
 * Which paths a runtime call may reach: decided by the hub, re-checked by the
 * runtime that owns the filesystem.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

/**
 * Which paths a call may reach, decided by the hub and enforced by the runtime.
 *
 * The two halves are not interchangeable. The hub knows the policy — the roots
 * a tool was configured with, whether the chat is pinned to its working
 * directory — but it checks that policy lexically, against strings. Only the
 * host that owns the filesystem can say where a path actually lands, because
 * only that host can follow the symlinks on the way and canonicalize the root
 * in its own path style. A link inside the working directory that points out of
 * it is invisible from anywhere else.
 *
 * So this travels on every filesystem method and is re-checked on arrival.
 * `containmentRoot` is the chat's working directory when the chat is restricted
 * to it; the roots are the configured allow and deny lists.
 */
export const RuntimePathFilterSchema = Type.Object({
  allowedRoots: ReadonlyArraySchema(Type.String({ minLength: 1 })),
  deniedRoots: ReadonlyArraySchema(Type.String({ minLength: 1 })),
  containmentRoot: Type.Optional(Type.String({ minLength: 1 })),
});
export type RuntimePathFilter = Static<typeof RuntimePathFilterSchema>;

/**
 * Mixed into every filesystem method's parameters. Omitted when nothing is
 * configured and nothing is restricted, so an unrestricted call stays one.
 */
export const RuntimePathPolicyParamsSchema = Type.Object({
  pathPolicy: Type.Optional(RuntimePathFilterSchema),
});
export type RuntimePathPolicyParams = Static<typeof RuntimePathPolicyParamsSchema>;
