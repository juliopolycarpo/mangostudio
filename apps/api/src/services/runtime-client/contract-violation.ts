/**
 * What the hub raises when a runtime peer breaks its side of `RUNTIME_CONTRACT`:
 * a method result, or a known event's payload, that fails the schema the
 * catalog publishes for it.
 *
 * Lives beside {@link ./hub-session}, not `@mangostudio/shared/runtime-contract`'s
 * `service-errors.ts`: that table is the wire vocabulary a runtime handler
 * throws and a hub rebuilds from `details.kind` — both ends agree on it. This
 * error never crosses the wire in either direction; it is what the hub raises
 * about the wire itself, so it belongs with the boundary that raises it.
 */

import type { TSchema } from 'typebox';
import Value from 'typebox/value';

/** Longest a violation's `path` or `message` may be, belt-and-braces over the redaction below. */
const MAX_VIOLATION_TEXT_LENGTH = 200;

/** The first schema mismatch in a value, as a bounded pointer and description. */
export interface ContractViolation {
  /** JSON pointer into `schema` itself (TypeBox's `schemaPath`), not into `value`. */
  readonly path: string;
  /** TypeBox's own description of the mismatch, e.g. "must be string". */
  readonly message: string;
}

/**
 * The first violation of `schema` by `value`, located by `schemaPath` rather
 * than `instancePath` — `schemaPath` is derived entirely from `schema`, which
 * this hub owns, so it cannot repeat anything the peer sent. `instancePath`
 * can: `RUNTIME_CONTRACT` has methods whose result carries a
 * `Type.Record(Type.String(), …)` (`probing.*`'s `findings[].params`), and an
 * `instancePath` walks into a record by its *key* — a peer-chosen string that
 * could be anything, including whatever it is this diagnostic exists to keep
 * out of a log line.
 *
 * `@mangostudio/protocol`'s contract builder computes the equivalent thing
 * for its own server-side `validateResults` check (by `instancePath`, since a
 * server already trusts its own handler's output), but keeps it private to
 * its module; this is the hub's own copy for the client side, which the SDK
 * does not validate at all (see `RuntimeContractViolationError`).
 *
 * @example
 * describeContractViolation(Type.Object({ a: Type.String() }), { a: 1 });
 * // => { path: '#/properties/a', message: 'must be string' }
 */
export function describeContractViolation(schema: TSchema, value: unknown): ContractViolation {
  const error = Value.Errors(schema, value)[0];
  return {
    path: bounded(error?.schemaPath || '#/'),
    message: bounded(error?.message ?? 'value does not match the contract'),
  };
}

function bounded(text: string): string {
  return text.length > MAX_VIOLATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_VIOLATION_TEXT_LENGTH)}…`
    : text;
}

/**
 * A runtime peer answered a method, or published an event, with a shape
 * `RUNTIME_CONTRACT` does not recognize. `subject` is the method or topic name
 * and `path`/`message` locate the mismatch — the message never repeats the
 * rejected payload, so logging or surfacing this error cannot leak it.
 *
 * @example
 * throw new RuntimeContractViolationError('result', 'fs.read-file', {
 *   path: '/content',
 *   message: 'must be string',
 * });
 */
export class RuntimeContractViolationError extends Error {
  readonly kind: 'result' | 'event';
  readonly subject: string;
  readonly path: string;

  constructor(kind: 'result' | 'event', subject: string, violation: ContractViolation) {
    super(
      `Runtime ${kind} for "${subject}" does not match the contract at ${violation.path}: ${violation.message}.`
    );
    this.name = 'RuntimeContractViolationError';
    this.kind = kind;
    this.subject = subject;
    this.path = violation.path;
  }
}
