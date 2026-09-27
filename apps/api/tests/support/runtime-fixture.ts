/**
 * A runtime the hub can actually talk to, built from a handful of handlers.
 *
 * Every frame goes through the real codec, so a test proves the same thing a
 * remote transport would: the parameters encode, the result decodes, the events
 * arrive in order. What it does not do is spawn anything — the handlers are the
 * test's own, served by `fake-runtime-host.ts` over the protocol SDK alone.
 */

import type { EventInput } from '@mangostudio/protocol';
import type {
  HubExternalAgentIsolation,
  RuntimeCapabilityManifest,
  RuntimeMethod,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { HubSession } from '../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import {
  connectFakeRuntime,
  type FakeConsentSource,
  type FakeRuntimeAudit,
  FakeRuntimeDefinition,
  fixedConsent,
  type TestHandler,
} from './fake-runtime-host';

export { FakeRuntimeDefinition, fixedConsent, type TestHandler };

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

export interface TestRuntimeOptions {
  readonly handlers: Partial<Record<RuntimeMethod, TestHandler>>;
  readonly manifest?: RuntimeCapabilityManifest;
  /** Defaults to a full grant on the `host` slot, so the gate never refuses. */
  readonly consent?: FakeConsentSource;
  readonly runtimeVersion?: string;
  readonly hubVersion?: string;
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
  /** Records what the runtime side saw, including who the hub said it is. */
  readonly audit?: FakeRuntimeAudit;
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
    consent: options.consent ?? fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
    handlers: options.handlers,
    ...(options.audit ? { audit: options.audit } : {}),
  });
  const connection = await connectFakeRuntime(definition, {
    hubVersion: options.hubVersion ?? 'hub-test',
    ...(options.externalAgentIsolation
      ? { externalAgentIsolation: options.externalAgentIsolation }
      : {}),
  });

  return {
    client: new RuntimeClient(connection.hub),
    hub: connection.hub,
    emit: (event) => {
      definition.emit(event);
    },
    close: () => connection.close(),
  };
}
