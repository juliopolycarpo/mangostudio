/**
 * Hub-process memory of the last slash-command catalog a vendor announced,
 * per `(userId, environmentId, targetId)`.
 *
 * Not database-backed and not chat-scoped, on purpose. `command-catalog.ts` on
 * the frontend already keeps the live, per-chat catalog a running session
 * announced; this exists only to answer the gap before a chat's own first turn
 * re-announces one after a reload. That narrow job is what lets it be a
 * process-local cache rather than a table: the worst failure is a stale name
 * offered in a palette, and the catalog was already documented as a hint, not
 * an allowlist.
 *
 * Keying coarser than a chat is a deliberate trade, not an oversight. Claude's
 * catalog includes project-scoped commands read from the session's cwd, so a
 * chat open on workspace B can briefly be served workspace A's names, until
 * its own first turn overwrites this same key with its own. Keying per chat
 * would not shrink that window — the same vendor process still writes
 * whichever key was current when it ran — and would multiply the cache for no
 * benefit.
 */

import type {
  ExternalAgentCommand,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { setBounded } from '../../../lib/bounded-map';

export interface ExternalCommandCatalogKey {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
}

export interface ExternalCommandCatalogCache {
  read(key: ExternalCommandCatalogKey): readonly ExternalAgentCommand[] | undefined;
  write(key: ExternalCommandCatalogKey, commands: readonly ExternalAgentCommand[]): void;
}

/** Generous relative to any real deployment's distinct (user, environment, target) count. */
const MAX_ENTRIES = 1_000;

function keyOf(key: ExternalCommandCatalogKey): string {
  return `${key.userId}\0${key.environmentId}\0${key.targetId}`;
}

export function createExternalCommandCatalogCache(): ExternalCommandCatalogCache {
  const byKey = new Map<string, readonly ExternalAgentCommand[]>();

  return {
    read(key) {
      return byKey.get(keyOf(key));
    },
    write(key, commands) {
      setBounded(byKey, keyOf(key), commands, MAX_ENTRIES);
    },
  };
}

export const externalCommandCatalogCache: ExternalCommandCatalogCache =
  createExternalCommandCatalogCache();
