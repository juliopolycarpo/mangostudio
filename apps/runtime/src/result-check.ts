/**
 * Checking a handler's return value against the contract's result schema
 * before it leaves the process.
 *
 * ## Why not `ServeOptions.validateResults`
 *
 * The SDK runs the same check, but it runs it *outside* the handler it was
 * given: `serve` awaits the gated handler — which has already written
 * `outcome: "ok"` to the audit log — and validates the value afterwards. A
 * malformed result would answer the hub with `INTERNAL` while the machine's own
 * receipt said the call succeeded, and the audit log is what an operator reads
 * when the hub's records are not theirs to see. Wrapping the handlers *inside*
 * the gate puts the verdict where the audit line can still change.
 *
 * The refusal is deliberately the same code and the same sentence the SDK
 * raises, so turning the check off and on does not change what a hub is told.
 *
 * @example
 * const handlers = gateHandlers(checkResults(registry.handlers), deps);
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { RUNTIME_CONTRACT, type RuntimeMethod } from '@mangostudio/shared/runtime-contract';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import type { RuntimeHandlers } from './handlers';

/**
 * Wraps every handler so a result the contract does not describe throws
 * `INTERNAL` instead of being sent.
 *
 * @example
 * const checked = checkResults(registry.handlers);
 */
export function checkResults(handlers: RuntimeHandlers): RuntimeHandlers {
  const check = <K extends RuntimeMethod>(method: K, handle: RuntimeHandlers[K]) =>
    (async (params: never, context: never) => {
      const result = await handle(params, context);
      const schema = RUNTIME_CONTRACT.definition.methods[method].result;
      if (!Value.Check(schema, result)) throw resultRefusal(method, schema, result);
      return result;
    }) as RuntimeHandlers[K];

  return Object.fromEntries(
    Object.entries(handlers).map(([method, handle]) => [
      method,
      check(method as RuntimeMethod, handle as RuntimeHandlers[RuntimeMethod]),
    ])
  ) as unknown as RuntimeHandlers;
}

/**
 * `INTERNAL` naming the failing path, because the hub cannot act on this and
 * the person reading the runtime's log is the one who can.
 */
function resultRefusal(method: string, schema: TSchema, value: unknown): RemoteError {
  const error = Value.Errors(schema, value)[0];
  if (!error) {
    return new RemoteError(
      RESERVED_ERROR_CODES.INTERNAL,
      `Result of "${method}" does not match the contract.`,
      { method }
    );
  }
  const property = error.keyword === 'required' ? error.params.requiredProperties[0] : undefined;
  const path = (property ? `${error.instancePath}/${property}` : error.instancePath) || '/';
  return new RemoteError(
    RESERVED_ERROR_CODES.INTERNAL,
    `Result of "${method}" does not match the contract at ${path}: ${error.message}.`,
    { method, path, reason: error.message }
  );
}
