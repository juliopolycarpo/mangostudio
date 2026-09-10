/**
 * Turning the recorded `allow` set into something that actually refuses, and
 * writing down what was asked either way.
 *
 * Without this the consent file is a note about intent: `setup --profile
 * readonly` records that a hub may not run commands here, every handler stays
 * registered, and the next `shell.run` succeeds. A permission a system does not
 * enforce is worse than one it never offered, because somebody read the prompt
 * and believed the answer.
 *
 * Refusal happens at dispatch rather than at registration. A method that is not
 * registered comes back as `METHOD_UNSUPPORTED`, which is what an older runtime
 * says about a method it has never heard of — a hub cannot tell "this release
 * lacks it" from "this machine forbids it", and only one of those has a fix
 * anyone can act on. So the method stays in the map and answers with the
 * capability it needed and the command that grants it.
 *
 * Which capabilities a method needs is the contract's own `capabilities` list,
 * so a new method without one is a compile error in the shared contract rather
 * than a silently ungoverned hole here.
 *
 * The allow set is re-read on every call through {@link RuntimeConsentSource},
 * so a mid-connection `setup` takes effect without reconnecting.
 *
 * ## Why a wrapper and not `ServeOptions.guard`
 *
 * The SDK offers a guard that runs before every handler with the method's
 * capability list, which is exactly the consent decision — but only that. The
 * guard never sees the parameters the audit line summarises, cannot see how
 * many requests are in flight (which is what update exclusivity is decided
 * from), and runs *before* the contract validates parameters, so a refusal it
 * raised would bypass everything below. The capability list still comes from
 * the contract; only the place it is read from moved.
 *
 * One consequence: parameter validation now runs first, so a non-object payload
 * answers `INVALID_PARAMS` where it used to answer a refusal, and writes no
 * audit line — there was no method call to record.
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import {
  CONSENT_DENIED_KIND,
  RUNTIME_CONTRACT,
  RUNTIME_UPDATE_REFUSED,
  type RuntimeMethod,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeCapabilityAllow, RuntimeSlot } from '@mangostudio/shared/runtime-home';
import type { RuntimeAuditOutcome, RuntimeAuditSink } from './audit-log';
import type { RuntimeConsentSource } from './consent-source';
import { toRemoteError } from './errors';
import type { RuntimeHandlers } from './handlers';

export interface RuntimeGateDeps {
  readonly consent: RuntimeConsentSource;
  /** Absent means the slot has auditing off (the `host` default). */
  readonly audit?: RuntimeAuditSink;
  /** True between `runtime.update.begin` and `runtime.update.commit`. */
  readonly isUpdateActive: () => boolean;
}

/** Methods that carry a live binary; they and ordinary calls exclude each other. */
const UPDATE_METHOD_PREFIX = 'runtime.update.';

/**
 * Wraps every handler so a denied method refuses before it runs, an update and
 * an ordinary call never overlap, and each outcome reaches the audit log.
 *
 * @example
 * const handlers = gateHandlers(registry.handlers, { consent, isUpdateActive });
 * RUNTIME_CONTRACT.serve(session, handlers);
 */
export function gateHandlers(handlers: RuntimeHandlers, deps: RuntimeGateDeps): RuntimeHandlers {
  const inFlight = new Set<symbol>();
  const inFlightUpdates = new Set<symbol>();

  const gate = <K extends RuntimeMethod>(method: K, handle: RuntimeHandlers[K]) =>
    (async (params: never, context: never) => {
      const started = performance.now();
      const refusal = exclusivityRefusal(method, inFlight, inFlightUpdates, deps.isUpdateActive);
      if (refusal) {
        record(deps.audit, method, 'error', started, params, refusal);
        throw refusal;
      }

      // Claimed before the first `await`: consent is re-read from disk, and a
      // call that only claimed its slot afterwards would be invisible to an
      // update arriving in that window — which is the overlap this prevents.
      const token = Symbol(method);
      inFlight.add(token);
      if (method.startsWith(UPDATE_METHOD_PREFIX)) inFlightUpdates.add(token);
      let recorded = false;
      try {
        const allow = await deps.consent.refresh();
        const missing = missingCapabilities(method, allow);
        if (missing.length > 0) {
          const denial = consentDenial(method, missing, deps.consent.slot);
          record(deps.audit, method, 'denied', started, params, denial);
          recorded = true;
          throw denial;
        }
        const result = await handle(params, context);
        record(deps.audit, method, 'ok', started, params);
        recorded = true;
        return result;
      } catch (error) {
        const remote = toRemoteError(error);
        if (!recorded) {
          record(
            deps.audit,
            method,
            'error',
            started,
            params,
            remote instanceof RemoteError ? remote : undefined
          );
        }
        throw remote;
      } finally {
        inFlight.delete(token);
        inFlightUpdates.delete(token);
      }
    }) as RuntimeHandlers[K];

  return Object.fromEntries(
    Object.entries(handlers).map(([method, handle]) => [
      method,
      gate(method as RuntimeMethod, handle as RuntimeHandlers[RuntimeMethod]),
    ])
  ) as unknown as RuntimeHandlers;
}

/**
 * Why this call may not run beside what is already running, or undefined.
 *
 * An update rewrites the bytes this process is serving from, so it may not
 * overlap an ordinary call in either direction. Both refusals are the
 * application's own code, not a reserved one: the hub retries them.
 */
function exclusivityRefusal(
  method: RuntimeMethod,
  inFlight: ReadonlySet<symbol>,
  inFlightUpdates: ReadonlySet<symbol>,
  isUpdateActive: () => boolean
): RemoteError | undefined {
  const updateMethod = method.startsWith(UPDATE_METHOD_PREFIX);
  if (updateMethod && inFlight.size > 0) {
    return new RemoteError(
      RUNTIME_UPDATE_REFUSED,
      'Runtime update refused while another call is in flight.',
      { kind: 'runtime_update_refused', reason: 'call_in_flight' }
    );
  }
  if (!updateMethod && (inFlightUpdates.size > 0 || isUpdateActive())) {
    return new RemoteError(
      RUNTIME_UPDATE_REFUSED,
      'Runtime call refused while a binary update is in progress.',
      { kind: 'runtime_update_refused', reason: 'update_in_progress' }
    );
  }
  return undefined;
}

function consentDenial(method: string, missing: readonly string[], slot: RuntimeSlot): RemoteError {
  const because =
    missing.length > 0
      ? `this machine has not granted ${missing.join(' or ')}`
      : 'no capability governs it, so nothing can grant it';
  return new RemoteError(
    RESERVED_ERROR_CODES.DENIED,
    `"${method}" is refused: ${because}. Run "mangostudio-runtime setup --slot ${slot}" there to change what a hub may do.`,
    { kind: CONSENT_DENIED_KIND, method, missing, slot, capability: missing[0] }
  );
}

/** Which of a method's capabilities this machine has not granted. */
function missingCapabilities(
  method: RuntimeMethod,
  allow: RuntimeCapabilityAllow
): readonly (keyof RuntimeCapabilityAllow)[] {
  const required = RUNTIME_CONTRACT.definition.methods[method].capabilities;
  return required.filter((capability) => !allow[capability]);
}

function record(
  audit: RuntimeAuditSink | undefined,
  method: string,
  outcome: RuntimeAuditOutcome,
  started: number,
  params: unknown,
  error?: RemoteError
): void {
  const capability = error?.details?.capability;
  audit?.record({
    method,
    outcome,
    durationMs: performance.now() - started,
    params,
    ...(typeof capability === 'string' ? { capability } : {}),
    ...(error ? { code: error.code } : {}),
  });
}
