/**
 * The shape of the runtime's method implementations.
 *
 * A leaf: the registry that builds the map, the gate that wraps it and the
 * session that serves it all name this type, and none of them may reach the
 * others through it.
 *
 * The context is narrower than the SDK's `HandlerContext` on purpose. A handler
 * needs the call's `AbortSignal` and nothing else, and a function that asks for
 * less is still assignable to one the SDK will call with more — so the same map
 * satisfies `ContractHandlers` without every implementation depending on the
 * session object.
 */

import type { RuntimeMethod, RuntimeMethodMap } from '@mangostudio/shared/runtime-contract';

export interface RuntimeHandlerContext {
  /** Aborted by a `cancel` frame from the hub, or by the session closing. */
  readonly signal: AbortSignal;
}

export type RuntimeHandlers = {
  readonly [K in RuntimeMethod]: (
    params: RuntimeMethodMap[K]['params'],
    context: RuntimeHandlerContext
  ) => RuntimeMethodMap[K]['result'] | Promise<RuntimeMethodMap[K]['result']>;
};
