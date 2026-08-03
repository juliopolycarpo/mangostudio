import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeSlot,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeProtocolVersion } from '@mangostudio/shared/runtime-protocol';
import { gateHandlersByConsent } from './consent-gate';
import { RuntimeHost } from './host';
import { createLocalRuntimeManifest } from './manifest';
import { createRuntimeMethodHandlers } from './registry';

export function createLocalRuntimeHost(options: {
  readonly runtimeVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
  /**
   * What this machine's owner agreed a hub may do here, and the slot they
   * agreed it for. Defaults to everything: a caller that has not read a config
   * is one whose slot resolves to full consent anyway, and a gate that fails
   * closed on a missing argument would take the Docker image — which answers
   * nothing and is meant to serve — down with it.
   */
  readonly allow?: RuntimeCapabilityAllow;
  readonly slot?: RuntimeSlot;
}): RuntimeHost {
  // The registry needs an emitter and the host needs the registry, so the
  // emitter closes over the host rather than being handed it: events raised
  // before `attach` have nowhere to go anyway, and `emit` already drops them.
  let host: RuntimeHost | undefined;
  const registry = createRuntimeMethodHandlers({
    runtimeVersion: options.runtimeVersion,
    emit: (event) => host?.emit(event),
  });

  host = new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: createLocalRuntimeManifest(),
    handlers: gateHandlersByConsent(
      registry.handlers,
      options.allow ?? RUNTIME_CONSENT_PRESETS.full,
      options.slot ?? 'host'
    ),
    onClose: () => void registry.close(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
  });
  return host;
}
