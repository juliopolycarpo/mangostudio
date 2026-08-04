import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeSlot,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeProtocolVersion } from '@mangostudio/shared/runtime-protocol';
import { gateHandlersByConsent } from './consent-gate';
import { type RuntimeConsentSource, staticConsentSource } from './consent-source';
import { RuntimeHost } from './host';
import { createLocalRuntimeManifest } from './manifest';
import { createRuntimeMethodHandlers } from './registry';
import type { RuntimeUpdateServiceOptions } from './services/runtime-update';

export function createLocalRuntimeHost(options: {
  readonly runtimeVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
  /**
   * What this machine's owner agreed a hub may do here. Defaults to a static
   * full grant on the `host` slot: a caller that has not read a config is one
   * whose slot resolves to full consent anyway, and a gate that fails closed
   * on a missing argument would take the Docker image — which answers nothing
   * and is meant to serve — down with it.
   *
   * Prefer a slot-backed source (`createSlotConsentSource`) so a mid-connection
   * `setup` takes effect without reconnect. The `allow`/`slot` convenience
   * fields build a static source for callers that already resolved consent.
   */
  readonly consent?: RuntimeConsentSource;
  /** @deprecated Prefer `consent`. Kept for the short list of static call sites. */
  readonly allow?: RuntimeCapabilityAllow;
  /** @deprecated Prefer `consent`. */
  readonly slot?: RuntimeSlot;
  /** Live-update publication and restart behavior for this process mode. */
  readonly update?: Omit<RuntimeUpdateServiceOptions, 'slot'>;
}): RuntimeHost {
  // The registry needs an emitter and the host needs the registry, so the
  // emitter closes over the host rather than being handed it: events raised
  // before `attach` have nowhere to go anyway, and `emit` already drops them.
  let host: RuntimeHost | undefined;
  const consent =
    options.consent ??
    staticConsentSource(options.allow ?? RUNTIME_CONSENT_PRESETS.full, options.slot ?? 'host');
  const registry = createRuntimeMethodHandlers({
    runtimeVersion: options.runtimeVersion,
    emit: (event) => host?.emit(event),
    slot: consent.slot,
    ...(options.update ? { update: options.update } : {}),
  });

  host = new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: () => createLocalRuntimeManifest(consent.current()),
    handlers: gateHandlersByConsent(registry.handlers, consent),
    isUpdateActive: registry.updateActive,
    onClose: () => void registry.close(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
  });
  return host;
}
