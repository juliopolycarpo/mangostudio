import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeSlot,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeProtocolVersion } from '@mangostudio/shared/runtime-protocol';
import { createRuntimeAuditSink, type RuntimeAuditSink } from './audit-log';
import { gateHandlersByConsent } from './consent-gate';
import { type RuntimeConsentSource, staticConsentSource } from './consent-source';
import { RuntimeHost } from './host';
import { createLocalRuntimeManifest } from './manifest';
import { createRuntimeMethodHandlers } from './registry';
import { readRuntimeSlotState } from './runtime-home';
import type { ExternalAgentAdapter } from './services/external-agents/adapter';
import type { ExternalAgentSupervisorOptions } from './services/external-agents/supervisor';
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
  /**
   * Local audit receipt. Omitted in unit tests and in-process fixtures; the
   * long-lived CLI modes use {@link createSlotRuntimeHost} so enablement
   * follows `runtime.json` (off for `host`, on for `wsl`/`remote`).
   */
  readonly audit?: RuntimeAuditSink;
  readonly externalAgents?: Omit<
    ExternalAgentSupervisorOptions,
    'registry' | 'runtimeVersion' | 'emit' | 'consent'
  > & {
    readonly adapters?: readonly ExternalAgentAdapter[];
    readonly identityIsolation?: ExternalIdentityIsolation;
  };
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
    consent,
    ...(options.externalAgents ? { externalAgents: options.externalAgents } : {}),
  });

  host = new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: () =>
      createLocalRuntimeManifest(consent.current(), {
        targetIds: registry.externalAgentRegistry.targetIds,
        ...(options.externalAgents?.identityIsolation
          ? { identityIsolation: options.externalAgents.identityIsolation }
          : {}),
      }),
    handlers: gateHandlersByConsent(registry.handlers, consent),
    isUpdateActive: registry.updateActive,
    onClose: () => registry.close(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  return host;
}

/** A host and the sink it writes through, so the caller can drain it on exit. */
export interface SlotRuntimeHost {
  readonly host: RuntimeHost;
  readonly audit: RuntimeAuditSink;
}

/**
 * Builds a host whose audit enablement follows the slot's `runtime.json`, so
 * `setup --audit` takes effect on the next process start.
 *
 * The sink comes back with the host because closing it is the caller's job:
 * `RuntimeHost.close()` only flushes, since one process-scoped sink outlives
 * every reconnect and supersede that passes through it.
 */
export async function createSlotRuntimeHost(options: {
  readonly runtimeVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
  readonly consent: RuntimeConsentSource;
  readonly update?: Omit<RuntimeUpdateServiceOptions, 'slot'>;
  readonly env?: NodeJS.ProcessEnv;
  readonly audit?: RuntimeAuditSink;
  readonly externalAgents?: Omit<
    ExternalAgentSupervisorOptions,
    'registry' | 'runtimeVersion' | 'emit' | 'consent'
  > & {
    readonly adapters?: readonly ExternalAgentAdapter[];
    readonly identityIsolation?: ExternalIdentityIsolation;
  };
}): Promise<SlotRuntimeHost> {
  const audit =
    options.audit ??
    createRuntimeAuditSink({
      slot: options.consent.slot,
      enabled: (await readRuntimeSlotState(options.consent.slot, options.env)).config.audit.enabled,
      env: options.env,
    });
  const host = createLocalRuntimeHost({
    runtimeVersion: options.runtimeVersion,
    consent: options.consent,
    audit,
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.update ? { update: options.update } : {}),
    ...(options.externalAgents ? { externalAgents: options.externalAgents } : {}),
  });
  return { host, audit };
}
