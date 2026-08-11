/**
 * The half of the isolation proof only the hub can supply.
 *
 * A runtime can establish which OS account it runs as and whether a container's
 * isolation survives its mounts. It cannot establish the thing that actually
 * matters — that **one** MangoStudio user reaches that account. From inside, a
 * dedicated per-user SSH account and a shared service account that four people's
 * keys land in are indistinguishable: same uid, same home, same everything.
 *
 * The hub is the only party that sees both sides. It knows which MangoStudio
 * user each connection belongs to, and the attestation carries a fingerprint of
 * the credential home. So one credential home turning up under two users is
 * visible here and nowhere else, and that observation is what turns
 * `os-account` from a claim into a check.
 *
 * ## Contested means absent, for everybody
 *
 * When a second user appears on a fingerprint, the attestation is withdrawn from
 * *both* — not kept for whoever got there first. Granting the first claimant
 * would be reasoning about the wrong direction: the danger is not that the
 * newcomer reaches the incumbent's `~/.claude`, it is that a single vendor login
 * sits in that shared home and nobody can say whose it is. The incumbent running
 * turns against it is as likely to be using the newcomer's Pro seat as their
 * own. Withdrawing from everyone is the only answer that is true regardless of
 * whose login it turned out to be.
 *
 * Once contested, always contested for the life of the process. A user whose
 * connection drops does not un-share a credential home, and a registry that
 * healed on disconnect would restore attestation the moment somebody closed a
 * laptop.
 *
 * ## Why this is process state rather than a table
 *
 * It is derived, not decided. Everything it holds is rebuilt from the
 * attestations runtimes present when they connect, so a restarted hub re-learns
 * it from the same evidence rather than trusting a row that could outlive the
 * machine it described. Persisting it would also make it forgeable by anything
 * that can write the database, which is a strictly worse trust story than
 * recomputing it.
 */

import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import { createDiagnosticLogger } from '../../../lib/logger';
import { type ExternalSessionManager, externalSessionManager } from './external-session-manager';

const logger = createDiagnosticLogger('external-identity-isolation');

export interface ExternalIdentityIsolationClaim {
  readonly userId: string;
  readonly environmentId: string;
  /** Absent when the runtime attested nothing, which is already `unproven`. */
  readonly isolation?: ExternalIdentityIsolation;
}

export interface ExternalIdentityIsolationRegistry {
  /**
   * The attestation that actually holds for this user, or `undefined`.
   *
   * Called on both the discovery path and the authorization path, and it must
   * be: discovery is cached, so a collision detected after a descriptor was
   * built would otherwise be invisible until the cache expired.
   */
  resolve(claim: ExternalIdentityIsolationClaim): ExternalIdentityIsolation | undefined;
  /** Whether a fingerprint has been seen under more than one user. */
  isContested(fingerprint: string): boolean;
  /** Test seam; production state is only ever grown by observation. */
  reset(): void;
}

export interface ExternalIdentityIsolationRegistryOptions {
  /**
   * How a newly contested fingerprint stops the sessions already running on it.
   *
   * Not optional in spirit. The collision is usually discovered *while* the
   * incumbent has a live vendor process holding a shared credential home open,
   * and refusing only the next turn would leave that one running against
   * credentials the hub has just decided nobody can account for.
   */
  readonly sessions?: Pick<ExternalSessionManager, 'reapScope'>;
}

interface FingerprintRecord {
  readonly userIds: Set<string>;
  contested: boolean;
}

export function createExternalIdentityIsolationRegistry(
  options: ExternalIdentityIsolationRegistryOptions = {}
): ExternalIdentityIsolationRegistry {
  const sessions = options.sessions ?? externalSessionManager;
  const byFingerprint = new Map<string, FingerprintRecord>();

  function contest(fingerprint: string, record: FingerprintRecord): void {
    record.contested = true;
    logger.warn('credential_home_shared', {
      // The digest itself, never the users. It is non-reversible and is the only
      // handle an operator has for "which machine is this"; a list of user ids
      // in a log would be the personal data the fingerprint exists to avoid.
      fingerprint,
      userCount: record.userIds.size,
    });
    for (const userId of record.userIds) {
      // Continuation is kept: the vendor conversation is intact and is still
      // this chat's to resume if the environment ever becomes eligible again.
      // What is withdrawn is permission to keep running against it now.
      void sessions
        .reapScope({ userId }, 'consent-revoked', { keepContinuation: true })
        .catch((error: unknown) => {
          logger.warn('contested_reap_failed', { error: String(error) });
        });
    }
  }

  return {
    resolve(claim) {
      const isolation = claim.isolation;
      if (!isolation) return undefined;

      const fingerprint = isolation.credentialHomeFingerprint;
      const record = byFingerprint.get(fingerprint) ?? { userIds: new Set(), contested: false };
      byFingerprint.set(fingerprint, record);

      const known = record.userIds.has(claim.userId);
      record.userIds.add(claim.userId);
      // Newly contested only on the transition, so the reap fires once rather
      // than on every discovery poll for the rest of the process's life.
      if (!record.contested && !known && record.userIds.size > 1) contest(fingerprint, record);

      return record.contested ? undefined : isolation;
    },

    isContested(fingerprint) {
      return byFingerprint.get(fingerprint)?.contested === true;
    },

    reset() {
      byFingerprint.clear();
    },
  };
}

/**
 * The hub's registry. One per process, because the collision it detects is a
 * fact about this hub's whole population of users — a per-request instance
 * would compare each user only against themselves and never find anything.
 */
export const externalIdentityIsolationRegistry = createExternalIdentityIsolationRegistry();
