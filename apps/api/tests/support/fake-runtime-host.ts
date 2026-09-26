/**
 * A runtime host made of a test's own handlers, served with nothing but the
 * Mango Protocol SDK and the shared runtime contract.
 *
 * It stands where the in-process TypeScript runtime host used to stand for
 * hub tests, and keeps the properties those tests leaned on:
 *
 * - **The real frame path.** {@link connectFakeRuntime} joins the hub and this
 *   host with `@mangostudio/protocol/in-process` and `validateFrames: true`,
 *   so every frame is encoded to bytes, decoded and schema-checked on each
 *   hop. A value a remote transport would lose fails here too.
 * - **The contract's own validation.** Handlers are registered through
 *   `RUNTIME_CONTRACT.serve`, so parameters are checked before a handler runs
 *   and every result is checked against the method's result schema before it
 *   is sent (`validateResults`). A handler that answers a malformed shape
 *   fails with `INTERNAL`, the way a validating runtime answers; a test that
 *   needs a malformed frame *on the wire* uses `FakeHostileRuntimePeer`.
 * - **The consent gate.** A guard refuses a method whose contract
 *   capabilities the {@link FakeConsentSource} has not granted, with the same
 *   `DENIED` code and `details` (`kind`, `method`, `missing`, `slot`,
 *   `capability`) a real runtime sends, including the `captureSnapshot`
 *   carve-out that also requires `fsRead` and `checkpoints`.
 * - **Typed service errors.** A handler that throws a shared
 *   `RuntimeServiceError` reaches the hub as `INTERNAL` carrying its `kind`
 *   and data, so the hub can rebuild the class from the wire.
 * - **Hub identity.** Once both hellos have crossed, the validated
 *   `capabilities.hub` is handed to the definition's `audit.setHub`.
 *
 * What it deliberately is not: a runtime. There is no filesystem, shell, MCP
 * or terminal behind it. Tests that need real runtime behaviour drive the
 * compiled Rust binary instead (`rust-runtime-binary.ts`).
 */

import {
  type EventInput,
  type GuardContext,
  type Port,
  type ProtocolVersion,
  RESERVED_ERROR_CODES,
  RemoteError,
  Session,
} from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  CONSENT_DENIED_KIND,
  type HubExternalAgentIsolation,
  type HubIdentity,
  HubIdentitySchema,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_UPDATE_REFUSED,
  type RuntimeCapabilityManifest,
  type RuntimeMethod,
  RuntimeServiceError,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeCapabilityAllow, RuntimeSlot } from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import type { HubSession } from '../../src/services/runtime-client/hub-session';
import { openHubSession } from '../../src/services/runtime-client/hub-session';

/** Name a real runtime announces in its `hello`; the hub checks the role, not this. */
const RUNTIME_PEER_NAME = 'mangostudio-runtime';

/** One method of a fake runtime; `params` is the contract's, unnarrowed. */
export type TestHandler = (params: never, context: { readonly signal: AbortSignal }) => unknown;

/**
 * What this machine allows, re-read on every call the way a real runtime
 * re-reads its slot file.
 */
export interface FakeConsentSource {
  readonly slot: RuntimeSlot;
  current(): RuntimeCapabilityAllow;
  refresh(): Promise<RuntimeCapabilityAllow>;
}

/**
 * A consent source that never changes.
 *
 * @example
 * const consent = fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host');
 */
export function fixedConsent(allow: RuntimeCapabilityAllow, slot: RuntimeSlot): FakeConsentSource {
  return { slot, current: () => allow, refresh: async () => allow };
}

/** The runtime-side record of who the hub said it is. */
export interface FakeRuntimeAudit {
  /** Called with `null` when the session opens, then with the hub's validated identity. */
  setHub(hub: HubIdentity | null): void;
}

export interface FakeRuntimeDefinitionOptions {
  readonly runtimeVersion: string;
  readonly manifest: RuntimeCapabilityManifest;
  readonly consent: FakeConsentSource;
  readonly handlers: Partial<Record<RuntimeMethod, TestHandler>>;
  /** Absent means nobody records the hub identity. */
  readonly audit?: FakeRuntimeAudit;
  /** The wire version this runtime announces; absent means the SDK's own. */
  readonly protocol?: ProtocolVersion;
}

/**
 * A runtime definition whose methods are the test's, and whose unnamed
 * methods fail loudly.
 *
 * A default that answered `{}` would let a test pass while calling something
 * it never meant to, so the default throws with the method name in it.
 *
 * @example
 * const definition = new FakeRuntimeDefinition({
 *   runtimeVersion: 'runtime-test',
 *   manifest: TEST_RUNTIME_MANIFEST,
 *   consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
 *   handlers: { 'shell.run': () => ({ stdout: '', stderr: '', exitCode: 0 }) },
 * });
 */
export class FakeRuntimeDefinition {
  readonly runtimeVersion: string;
  readonly manifest: RuntimeCapabilityManifest;
  readonly consent: FakeConsentSource;
  readonly audit: FakeRuntimeAudit | undefined;
  readonly protocol: ProtocolVersion | undefined;
  readonly handlers: Readonly<Record<RuntimeMethod, TestHandler>>;
  #target: ((event: EventInput) => boolean) | undefined;

  constructor(options: FakeRuntimeDefinitionOptions) {
    this.runtimeVersion = options.runtimeVersion;
    this.manifest = options.manifest;
    this.consent = options.consent;
    this.audit = options.audit;
    this.protocol = options.protocol;
    const named = Object.keys(options.handlers).join(', ') || '(none)';
    this.handlers = Object.fromEntries(
      Object.keys(RUNTIME_CONTRACT.definition.methods).map((name) => {
        const method = name as RuntimeMethod;
        const missing: TestHandler = () => {
          throw new Error(
            `Runtime method "${method}" has no handler in this fixture; expected one of ${named}.`
          );
        };
        return [method, options.handlers[method] ?? missing];
      })
    ) as Record<RuntimeMethod, TestHandler>;
  }

  /**
   * Publishes an event on the session serving this definition. False when no
   * session is bound, or the bound one refused it (closed, or not ready).
   */
  emit(event: EventInput): boolean {
    return this.#target?.(event) ?? false;
  }

  /** Binds the session events go to; returns the function that unbinds it. */
  bind(target: (event: EventInput) => boolean): () => void {
    this.#target = target;
    return () => {
      if (this.#target === target) this.#target = undefined;
    };
  }
}

export interface ServeFakeRuntimeOptions {
  /** Passed to the SDK session; `false` keeps a liveness timer from holding a test open. */
  readonly livenessIntervalMs?: number | false;
}

/**
 * Serves `definition` over `port` until the transport ends, the way a runtime
 * binary serves one hub connection.
 *
 * Handlers are registered before this returns, so a request that arrives in
 * the same tick as the handshake still finds them.
 *
 * @example
 * const port = await connectWebSocket(url, { headers: { authorization: `Bearer ${token}` } });
 * const session = serveFakeRuntime(port, definition);
 * session.close(CLOSE_CODES.RELEASED, 'test over');
 */
export function serveFakeRuntime(
  port: Port,
  definition: FakeRuntimeDefinition,
  options: ServeFakeRuntimeOptions = {}
): Session {
  const session = new Session(port, {
    peer: { name: RUNTIME_PEER_NAME, version: definition.runtimeVersion, role: 'runtime' },
    capabilities: {
      ...definition.manifest,
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
    },
    ...(definition.protocol ? { protocol: definition.protocol } : {}),
    ...(options.livenessIntervalMs !== undefined
      ? { livenessIntervalMs: options.livenessIntervalMs }
      : {}),
  });

  RUNTIME_CONTRACT.serve(session, serviceErrorMappedHandlers(definition.handlers) as never, {
    validateResults: true,
    guard: (method, capabilities, context) =>
      refuseUngranted(method, capabilities, context, definition.consent),
  });

  const unbind = definition.bind((event) => session.emit(event));
  definition.audit?.setHub(null);
  session.ready.then(
    (remote) => definition.audit?.setHub(hubIdentityOf(remote.capabilities)),
    // A handshake that never completes is a closed session; the close
    // listener below is all the cleanup there is.
    () => undefined
  );
  session.onClose(() => unbind());
  return session;
}

/**
 * Throws the `DENIED` refusal a runtime sends for a method this machine has
 * not granted every capability of.
 */
async function refuseUngranted(
  method: string,
  capabilities: readonly string[],
  context: GuardContext,
  consent: FakeConsentSource
): Promise<void> {
  const allow = await consent.refresh();
  const required = new Set(capabilities);
  if (capturesMutationSnapshot(context.params)) {
    required.add('fsRead');
    required.add('checkpoints');
  }
  const missing = [...required].filter(
    (capability) => !allow[capability as keyof RuntimeCapabilityAllow]
  );
  if (missing.length === 0) return;
  throw new RemoteError(
    RESERVED_ERROR_CODES.DENIED,
    `"${method}" is refused: this machine has not granted ${missing.join(' or ')}. Run "mangostudio-runtime setup --slot ${consent.slot}" there to change what a hub may do.`,
    { kind: CONSENT_DENIED_KIND, method, missing, slot: consent.slot, capability: missing[0] }
  );
}

/** Snapshot-bearing mutations return file bytes and create checkpoint material. */
function capturesMutationSnapshot(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'captureSnapshot' in params &&
    params.captureSnapshot === true
  );
}

/** Every handler, with a thrown `RuntimeServiceError` flattened onto the wire. */
function serviceErrorMappedHandlers(
  handlers: Readonly<Record<RuntimeMethod, TestHandler>>
): Record<RuntimeMethod, TestHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handle]) => [
      method,
      async (params: never, context: { readonly signal: AbortSignal }) => {
        try {
          return await handle(params, context);
        } catch (error) {
          throw toWireError(error);
        }
      },
    ])
  ) as Record<RuntimeMethod, TestHandler>;
}

/**
 * The wire error a runtime sends for a thrown service error: consent as
 * `DENIED`, a refused update as `RUNTIME_UPDATE_REFUSED`, anything else as
 * `INTERNAL` with its `kind`. Other throws are left for the SDK to map
 * (`AbortError` → `CANCELLED`, everything else → `INTERNAL`).
 */
function toWireError(error: unknown): unknown {
  if (!(error instanceof RuntimeServiceError)) return error;
  const details = { kind: error.kind, ...error.data };
  if (error.kind === CONSENT_DENIED_KIND) {
    const missing = Array.isArray(error.data.missing) ? error.data.missing : [];
    const capability =
      typeof error.data.capability === 'string' ? error.data.capability : missing[0];
    return new RemoteError(RESERVED_ERROR_CODES.DENIED, error.message, { ...details, capability });
  }
  if (error.kind === 'runtime_update_refused') {
    return new RemoteError(RUNTIME_UPDATE_REFUSED, error.message, details);
  }
  return new RemoteError(RESERVED_ERROR_CODES.INTERNAL, error.message, details);
}

/** Who the hub said it is, validated rather than trusted from an open object. */
function hubIdentityOf(capabilities: Readonly<Record<string, unknown>>): HubIdentity | null {
  const hub = capabilities.hub;
  return Value.Check(HubIdentitySchema, hub) ? hub : null;
}

export interface ConnectFakeRuntimeOptions {
  readonly hubVersion: string;
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
  readonly handshakeTimeoutMs?: number;
}

export interface FakeRuntimeConnection {
  readonly hub: HubSession;
  readonly runtime: Session;
  /** Closes both ends; settles once the runtime side has seen the close. */
  close(): Promise<void>;
}

/**
 * Connects a hub session to `definition` through an in-process port pair that
 * re-encodes and validates every frame.
 *
 * @example
 * const connection = await connectFakeRuntime(definition, { hubVersion: 'hub-test' });
 * await connection.hub.request('runtime.health', {});
 * await connection.close();
 */
export async function connectFakeRuntime(
  definition: FakeRuntimeDefinition,
  options: ConnectFakeRuntimeOptions
): Promise<FakeRuntimeConnection> {
  const ports = createInProcessPortPair({ validateFrames: true });
  const runtime = serveFakeRuntime(ports.b, definition);
  const runtimeClosed = new Promise<void>((resolve) => runtime.onClose(() => resolve()));

  let hub: HubSession;
  try {
    hub = await openHubSession(ports.a, {
      hubVersion: options.hubVersion,
      workspaceBinding: null,
      ...(options.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
        : {}),
      ...(options.externalAgentIsolation !== undefined
        ? { externalAgentIsolation: options.externalAgentIsolation }
        : {}),
    });
  } catch (error) {
    runtime.close();
    throw error;
  }

  return {
    hub,
    runtime,
    async close() {
      hub.close();
      runtime.close();
      await runtimeClosed;
    },
  };
}
