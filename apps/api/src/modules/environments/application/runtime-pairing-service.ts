/**
 * Issues, revokes, and verifies the machine credentials a dial-in runtime uses
 * to authenticate its WebSocket upgrade.
 *
 * A token authorizes exactly one environment row. Revoking it, or removing the
 * row it belongs to, drops whatever socket it opened: a connection must never
 * outlive the credential that authorized it.
 */

import type {
  RuntimePairingIssue,
  RuntimePairingStatus,
  RuntimePairingToken,
} from '@mangostudio/shared/environments';
import { getConfig } from '../../../lib/config';
import { publishEnvironmentInvalidation } from '../../../services/realtime/environment-invalidation';
import {
  getRuntimeConnectionManager,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { constantTimeEquals } from '../../../utils/hash';
import {
  generatePairingToken,
  hashPairingSecret,
  parsePairingToken,
  runtimeDialEndpoint,
} from '../domain/pairing-token';
import {
  type EnvironmentRepository,
  environmentRepository,
} from '../infrastructure/environment-repository';
import {
  type RuntimePairingRepository,
  runtimePairingRepository,
} from '../infrastructure/runtime-pairing-repository';
import { EnvironmentServiceError } from './environment-service';

/** Transports where the runtime dials the hub and needs a credential to do it. */
const PAIRABLE_TRANSPORT_KINDS = new Set(['websocket']);

/**
 * A heartbeat every few seconds must not become a write every few seconds:
 * `lastSeenAt` is a coarse "this credential is in use" signal, not an activity
 * log, and 022 is where an audit trail belongs.
 */
const LAST_SEEN_THROTTLE_MS = 60_000;

interface VerifiedRuntimePairing {
  readonly tokenId: string;
  readonly userId: string;
  readonly environmentId: string;
}

export interface RuntimePairingService {
  status(userId: string, environmentId: string): Promise<RuntimePairingStatus>;
  issue(userId: string, environmentId: string): Promise<RuntimePairingIssue>;
  revoke(userId: string, environmentId: string): Promise<void>;
  /** Resolves a presented token, or null for anything the hub will not accept. */
  verify(presented: string): Promise<VerifiedRuntimePairing | null>;
  /**
   * Whether an already-verified token is still one the hub accepts. Cheaper
   * than `verify` and takes no secret, so a long-lived connection can re-check
   * its own credential without holding the string that opened it.
   */
  isActive(tokenId: string): Promise<boolean>;
  /** Records that a verified token was used, throttled to minutes. */
  markSeen(tokenId: string): Promise<void>;
}

function toSummary(record: {
  readonly environmentId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
}): RuntimePairingToken {
  return {
    environmentId: record.environmentId,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
  };
}

export interface RuntimePairingServiceDeps {
  readonly repository?: RuntimePairingRepository;
  readonly environments?: EnvironmentRepository;
  readonly manager?: RuntimeConnectionManager;
  readonly publish?: (userId: string) => void;
  /** Read per call, not per construction: config reloads without a restart. */
  readonly publicUrl?: () => string;
}

export function createRuntimePairingService(
  deps: RuntimePairingServiceDeps = {}
): RuntimePairingService {
  const repository = deps.repository ?? runtimePairingRepository;
  const environments = deps.environments ?? environmentRepository;
  const publish = deps.publish ?? publishEnvironmentInvalidation;
  const publicUrl = deps.publicUrl ?? (() => getConfig().server.publicUrl);
  // Resolved lazily so constructing the service never forces the manager
  // singleton into existence — the module graph would otherwise pull the whole
  // connection stack into any consumer that only needs to verify a token.
  const resolveManager = (): RuntimeConnectionManager =>
    deps.manager ?? getRuntimeConnectionManager();

  async function requirePairableEnvironment(userId: string, environmentId: string): Promise<void> {
    const environment = await environments.find(userId, environmentId);
    if (!environment) {
      throw new EnvironmentServiceError(`Environment "${environmentId}" was not found.`, 404);
    }
    if (!PAIRABLE_TRANSPORT_KINDS.has(environment.transportKind)) {
      throw new EnvironmentServiceError(
        `Environment "${environmentId}" does not use a transport the runtime dials in on.`,
        409
      );
    }
  }

  const lastSeenWrites = new Map<string, number>();

  return {
    async status(userId, environmentId) {
      await requirePairableEnvironment(userId, environmentId);
      const record = await repository.findActiveForEnvironment(userId, environmentId);
      return {
        endpoint: runtimeDialEndpoint(publicUrl()),
        token: record ? toSummary(record) : null,
      };
    },

    async issue(userId, environmentId) {
      await requirePairableEnvironment(userId, environmentId);
      const generated = generatePairingToken();
      const record = await repository.replace({
        id: generated.id,
        userId,
        environmentId,
        tokenHash: generated.tokenHash,
      });
      // Rotating invalidates whatever is connected on the old credential; the
      // runtime redials and authenticates with the string just handed out.
      resolveManager().disconnect(userId, environmentId);
      publish(userId);
      return { ...toSummary(record), token: generated.token };
    },

    async revoke(userId, environmentId) {
      await requirePairableEnvironment(userId, environmentId);
      const revoked = await repository.revokeForEnvironment(userId, environmentId);
      if (revoked === 0) {
        throw new EnvironmentServiceError(
          `Environment "${environmentId}" has no pairing token to revoke.`,
          404
        );
      }
      resolveManager().disconnect(userId, environmentId);
      publish(userId);
    },

    async verify(presented) {
      const parsed = parsePairingToken(presented);
      if (!parsed) return null;

      const record = await repository.findById(parsed.id);
      if (!record || record.revokedAt !== null) return null;
      if (!constantTimeEquals(hashPairingSecret(parsed.secret), record.tokenHash)) return null;

      return {
        tokenId: record.id,
        userId: record.userId,
        environmentId: record.environmentId,
      };
    },

    async isActive(tokenId) {
      // A deleted environment cascades its tokens away (migration 040), so a
      // missing row covers revocation, rotation, and removal in one read.
      const record = await repository.findById(tokenId);
      return record !== null && record.revokedAt === null;
    },

    async markSeen(tokenId) {
      const now = Date.now();
      const written = lastSeenWrites.get(tokenId) ?? 0;
      if (now - written < LAST_SEEN_THROTTLE_MS) return;

      lastSeenWrites.set(tokenId, now);
      await repository.touch(tokenId, now);
    },
  };
}

export const runtimePairingService = createRuntimePairingService();
