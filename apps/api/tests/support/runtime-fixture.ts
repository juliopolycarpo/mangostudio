/**
 * A runtime the hub can actually talk to, built from a handful of handlers.
 *
 * Every frame goes through the real codec, so a test proves the same thing a
 * remote transport would: the parameters encode, the result decodes, the events
 * arrive in order. What it does not do is spawn anything — the handlers are the
 * test's own.
 */

import type { EventInput } from '@mangostudio/protocol';
import {
  createRuntimeEventRelay,
  type RuntimeAuditSink,
  type RuntimeConsentSource,
  type RuntimeHandlers,
  type RuntimeHostDefinition,
  staticConsentSource,
} from '@mangostudio/runtime';
import {
  RUNTIME_CONTRACT,
  type RuntimeCapabilityManifest,
  type RuntimeMethod,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { connectInProcessRuntime } from '../../src/services/runtime-client/connect-in-process-runtime';
import type { HubSession } from '../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../src/services/runtime-client/runtime-client';

/** A manifest that claims nothing beyond "this peer exists and can be asked". */
export const TEST_RUNTIME_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

/** One method of a fixture runtime; `params` is the contract's, unnarrowed. */
export type TestHandler = (params: never, context: { readonly signal: AbortSignal }) => unknown;

/**
 * A host definition whose methods are the test's, and whose unnamed methods
 * fail loudly.
 *
 * The contract requires a handler for all 67 methods, and a default that
 * answered `{}` would let a test pass while calling something it never meant
 * to — so the default throws with the method name in it.
 *
 * @example
 * const definition = new FakeRuntimeDefinition({
 *   runtimeVersion: 'runtime-test',
 *   manifest: TEST_RUNTIME_MANIFEST,
 *   consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host'),
 *   handlers: { 'shell.run': () => ({ exitCode: 0 }) },
 * });
 */
export class FakeRuntimeDefinition implements RuntimeHostDefinition {
  readonly runtimeVersion: string;
  readonly manifest: () => RuntimeCapabilityManifest;
  readonly handlers: RuntimeHandlers;
  readonly consent: RuntimeConsentSource;
  readonly isUpdateActive = () => false;
  readonly events = createRuntimeEventRelay();
  readonly onClose = () => undefined;
  readonly audit: RuntimeAuditSink | undefined;

  constructor(options: {
    readonly runtimeVersion: string;
    readonly manifest: RuntimeCapabilityManifest;
    readonly consent: RuntimeConsentSource;
    readonly handlers: Partial<Record<RuntimeMethod, TestHandler>>;
    /** Absent means auditing is off, the way the `host` slot ships. */
    readonly audit?: RuntimeAuditSink;
  }) {
    this.runtimeVersion = options.runtimeVersion;
    this.audit = options.audit;
    this.manifest = () => options.manifest;
    this.consent = options.consent;
    this.handlers = Object.fromEntries(
      Object.keys(RUNTIME_CONTRACT.definition.methods).map((name) => {
        const method = name as RuntimeMethod;
        const handle = options.handlers[method];
        return [
          method,
          handle ??
            (() => {
              throw new Error(
                `Runtime method "${method}" has no handler in this fixture; expected one of ${Object.keys(options.handlers).join(', ') || '(none)'}.`
              );
            }),
        ];
      })
    ) as unknown as RuntimeHandlers;
  }
}

export interface TestRuntimeOptions {
  readonly handlers: Partial<Record<RuntimeMethod, TestHandler>>;
  readonly manifest?: RuntimeCapabilityManifest;
  /** Defaults to a full grant on the `host` slot, so the gate never refuses. */
  readonly consent?: RuntimeConsentSource;
  readonly runtimeVersion?: string;
  readonly hubVersion?: string;
  /** Records what the runtime side saw, including who the hub said it is. */
  readonly audit?: RuntimeAuditSink;
}

export interface TestRuntime {
  readonly client: RuntimeClient;
  readonly hub: HubSession;
  /** Publishes an event the way a runtime service would. */
  emit(event: EventInput): void;
  close(): Promise<void>;
}

/**
 * Connects a `RuntimeClient` to a runtime made of the handlers you name.
 *
 * @example
 * const runtime = await connectTestRuntime({
 *   handlers: { 'git.exec': () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
 * });
 * await runtime.client.git.exec({ args: ['status'], cwd: '/repo' });
 * await runtime.close();
 */
export async function connectTestRuntime(options: TestRuntimeOptions): Promise<TestRuntime> {
  const definition = new FakeRuntimeDefinition({
    runtimeVersion: options.runtimeVersion ?? 'runtime-test',
    manifest: options.manifest ?? TEST_RUNTIME_MANIFEST,
    consent: options.consent ?? staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host'),
    handlers: options.handlers,
    ...(options.audit ? { audit: options.audit } : {}),
  });
  const connection = await connectInProcessRuntime(definition, {
    hubVersion: options.hubVersion ?? 'hub-test',
    validateFrames: true,
  });

  return {
    client: new RuntimeClient(connection.hub),
    hub: connection.hub,
    emit: (event) => {
      definition.events.emit(event);
    },
    close: () => connection.close(),
  };
}
