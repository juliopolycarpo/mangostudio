/**
 * The real Local runtime definition, with the two seams these suites need.
 *
 * `connectTestRuntime` builds a runtime out of a handful of handlers, which is
 * what most tests want. These are the ones that need the opposite: every real
 * handler, because what they assert is what the hub put on the wire and what
 * the runtime's own code did with it. The two seams are a reshaped manifest —
 * a peer from before some declaration existed, without cutting a release for
 * it — and a handler wrapper that records what arrived.
 */

import {
  createLocalRuntimeManifest,
  createRuntimeEventRelay,
  createRuntimeMethodHandlers,
  type RuntimeHandlers,
  type RuntimeHostDefinition,
  staticConsentSource,
} from '@mangostudio/runtime';
import type {
  RuntimeCapabilityManifest,
  RuntimeMethod,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';

export interface LocalRuntimeDefinitionOptions {
  readonly runtimeVersion?: string;
  /** Rewrites the announced manifest, for a peer that declares less than this build. */
  readonly reshapeManifest?: (manifest: RuntimeCapabilityManifest) => RuntimeCapabilityManifest;
  /**
   * Sees the params of every call as the runtime received them — behind the
   * protocol, so what it records is what a remote peer would have been sent.
   */
  readonly recordCall?: (method: RuntimeMethod, params: unknown) => void;
}

/**
 * Builds a Local runtime definition backed by the real method registry.
 *
 * @example
 * const definition = createLocalRuntimeDefinition({
 *   reshapeManifest: (manifest) => ({ ...manifest, homeDir: '/tmp/target' }),
 * });
 * const connection = await connectInProcessRuntime(definition, { hubVersion: 'test' });
 */
export function createLocalRuntimeDefinition(
  options: LocalRuntimeDefinitionOptions = {}
): RuntimeHostDefinition {
  const runtimeVersion = options.runtimeVersion ?? 'test';
  const events = createRuntimeEventRelay();
  const registry = createRuntimeMethodHandlers({ runtimeVersion, emit: events.emit });
  const reshape = options.reshapeManifest;
  const record = options.recordCall;

  return {
    runtimeVersion,
    manifest: () => {
      const manifest = createLocalRuntimeManifest();
      return reshape ? reshape(manifest) : manifest;
    },
    handlers: record ? recordingHandlers(registry.handlers, record) : registry.handlers,
    consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host'),
    isUpdateActive: registry.updateActive,
    onClose: () => registry.close(),
    events,
  };
}

/** Every method of `handlers`, each reporting its params to `record` first. */
function recordingHandlers(
  handlers: RuntimeHandlers,
  record: (method: RuntimeMethod, params: unknown) => void
): RuntimeHandlers {
  type Untyped = (params: unknown, context: unknown) => unknown;
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handle]) => [
      method,
      (params: unknown, context: unknown) => {
        record(method as RuntimeMethod, params);
        return (handle as Untyped)(params, context);
      },
    ])
  ) as unknown as RuntimeHandlers;
}
