/**
 * What one external turn is allowed to run as, decided server-side.
 *
 * Three facts have to be true before a vendor process is asked to do anything,
 * and none of them can come from the request:
 *
 * 1. **The workspace, as the target machine spells it.** The runtime authorizes
 *    a workspace by matching the chat's stored `workdir` against a canonical
 *    path, so canonicalizing has to use the *target's* path semantics — a
 *    Windows hub driving a WSL distro does not resolve paths the way the distro
 *    does. A client-supplied path would be the vendor's working directory.
 * 2. **The permission pair, as the adapter vetted it.** The two axes are product
 *    vocabulary and are not freely composable: each adapter returns the
 *    combinations it actually supports, and a pair outside that list is refused
 *    here rather than sent and reinterpreted by a vendor.
 * 3. **Which account the vendor is signed in as.** The session's continuation is
 *    only valid for the account it was opened under, so the fingerprint travels
 *    with the turn.
 * 4. **That the vendor's credentials are this user's to spend.** The environment
 *    has to have attested an isolated OS identity, and that identity must not be
 *    one another MangoStudio user also reaches.
 *
 * Discovery answers 2 and 3 from the adapter that would run the turn and is
 * cached per (user, environment), so the ordinary send costs no extra probe.
 *
 * 4 is deliberately **not** taken from that cache. The descriptor carries an
 * `isolation-unproven` reason and it is checked, but a cached descriptor is a
 * statement about the past: a second user can arrive on a shared credential home
 * in the seconds between a probe and a send. Discovery is cached; authorization
 * is not, so the attestation is re-resolved here against the live manifest.
 */

import type {
  ExternalAgentConfiguration,
  ExternalAgentDescriptor,
  ExternalAgentTargetId,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
} from '@mangostudio/shared/external-agents';
import {
  normalizeApprovalRouting,
  normalizePermissionLevel,
} from '@mangostudio/shared/external-agents';
import type { ExternalTurnRequest } from '@mangostudio/shared/generation';
import { getRuntimeClient } from '../../../services/runtime-client';
import type { OwnedChatRecord } from '../../chats/infrastructure/chat-repository';
import {
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from './external-agent-discovery';
import {
  type ExternalIdentityIsolationRegistry,
  externalIdentityIsolationRegistry,
} from './external-identity-isolation';

export type ExternalTurnConfigurationResolution =
  | {
      readonly ok: true;
      readonly configuration: ExternalAgentConfiguration;
      readonly canonicalWorkspacePath: string;
      readonly vendorAccountFingerprint: string | null;
      /** The attested credential home. Never null on an `ok` resolution. */
      readonly credentialHomeFingerprint: string;
      readonly descriptor: ExternalAgentDescriptor;
    }
  | {
      readonly ok: false;
      readonly message: string;
      /**
       * Set when the refusal is the isolation gate rather than a configuration
       * one. The two read very differently to a user — one is "change a
       * setting", the other is "this machine cannot keep logins apart" — and
       * only the second has an operator action behind it.
       */
      readonly isolationUnproven?: true;
    };

export interface ResolveExternalTurnConfigurationInput {
  readonly userId: string;
  readonly chat: OwnedChatRecord;
  readonly targetId: ExternalAgentTargetId;
  readonly workdir: string;
  readonly request?: ExternalTurnRequest;
}

export interface ExternalTurnConfigurationDependencies {
  readonly discovery?: ExternalAgentDiscoveryService;
  readonly resolveRuntimeClient?: typeof getRuntimeClient;
  readonly isolationRegistry?: ExternalIdentityIsolationRegistry;
}

export function createExternalTurnConfigurationResolver(
  dependencies: ExternalTurnConfigurationDependencies = {}
) {
  const discovery = dependencies.discovery ?? externalAgentDiscoveryService;
  const resolveRuntimeClient = dependencies.resolveRuntimeClient ?? getRuntimeClient;
  const isolationRegistry = dependencies.isolationRegistry ?? externalIdentityIsolationRegistry;

  return async function resolveExternalTurnConfiguration(
    input: ResolveExternalTurnConfigurationInput
  ): Promise<ExternalTurnConfigurationResolution> {
    // Throws when the environment cannot be reached, which the caller reports as
    // an unavailable machine rather than as a refused configuration.
    const client = await resolveRuntimeClient(input.userId, input.chat.environmentId);
    const canonicalWorkspacePath = client.paths.canonical(input.workdir);

    // Before anything else that costs a probe: an environment that cannot keep
    // vendor logins apart per user has no configuration worth resolving.
    const isolation = isolationRegistry.resolve({
      userId: input.userId,
      environmentId: input.chat.environmentId,
      // Optional all the way down: a client with no manifest has attested
      // nothing, which is a refusal rather than a crash. A 500 here would read
      // to the user as MangoStudio breaking, not as the machine being ineligible.
      ...(client.manifest?.identityIsolation
        ? { isolation: client.manifest.identityIsolation }
        : {}),
    });
    if (!isolation) {
      return {
        ok: false,
        isolationUnproven: true,
        message: 'This machine has not proved it can keep vendor logins separate per user.',
      };
    }

    const agents = await discovery.listExternalAgents({
      userId: input.userId,
      environmentId: input.chat.environmentId,
    });
    const descriptor = agents.find((agent) => agent.targetId === input.targetId);
    if (!descriptor) {
      return { ok: false, message: 'This agent is not available on that machine.' };
    }
    if (descriptor.unavailableReason) {
      return {
        ok: false,
        message: `This agent cannot run here right now (${descriptor.unavailableReason}).`,
      };
    }

    const level = normalizePermissionLevel(input.chat.runnerPermissions.level).value;
    const routing = normalizeApprovalRouting(input.chat.runnerPermissions.routing).value;
    if (!isSupportedPair(descriptor, level, routing)) {
      return {
        ok: false,
        message: 'This agent does not support the permission combination this chat is set to.',
      };
    }

    const model = pickModel(descriptor, input.request?.model);
    const effort = pickEffort(descriptor, model, input.request?.effort);

    return {
      ok: true,
      configuration: {
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        level,
        routing,
        // The vendor's writable root. One entry: multi-root is out of scope, and
        // an empty list would leave `workspaceWrite` with nothing to write to.
        workspaceRoots: [canonicalWorkspacePath],
      },
      canonicalWorkspacePath,
      vendorAccountFingerprint: descriptor.account?.fingerprint ?? null,
      credentialHomeFingerprint: isolation.credentialHomeFingerprint,
      descriptor,
    };
  };
}

function isSupportedPair(
  descriptor: ExternalAgentDescriptor,
  level: ExternalPermissionLevel,
  routing: ExternalApprovalRouting
): boolean {
  return descriptor.supportedConfigurations.some(
    (candidate) => candidate.level === level && candidate.routing === routing && candidate.supported
  );
}

/**
 * The model to run as, when the vendor advertised a catalog.
 *
 * A request naming a model the catalog does not list is ignored rather than
 * refused: catalogs are per-account and can change between the render that
 * populated the picker and the send, and failing the turn over a stale dropdown
 * would be a worse answer than the vendor's own default. `hidden` entries are
 * honored — the vendor marked them as not for a picker — but a request that
 * names one explicitly is still allowed through, since something showed it.
 */
function pickModel(
  descriptor: ExternalAgentDescriptor,
  requested: string | undefined
): string | undefined {
  const models = descriptor.models;
  if (!models || models.length === 0) return requested;
  if (requested && models.some((model) => model.id === requested)) return requested;
  return models.find((model) => model.isDefault && model.hidden !== true)?.id;
}

/**
 * Same rule for effort, scoped to the model actually chosen.
 *
 * When the vendor advertised a catalog but no model resolved out of it — a
 * request naming something unlisted, and no visible default to fall back to —
 * the requested effort was never vetted against anything, so nothing is sent.
 * Forwarding it would be this function claiming a scope it does not have.
 */
function pickEffort(
  descriptor: ExternalAgentDescriptor,
  modelId: string | undefined,
  requested: string | undefined
): string | undefined {
  const models = descriptor.models;
  // No catalog at all: the request is the only signal there is.
  if (!models || models.length === 0) return requested;
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return undefined;
  const efforts = model.supportedReasoningEfforts;
  if (!efforts || efforts.length === 0) return undefined;
  if (requested && efforts.some((effort) => effort.id === requested)) return requested;
  return model.defaultReasoningEffort;
}

export const resolveExternalTurnConfiguration = createExternalTurnConfigurationResolver();
