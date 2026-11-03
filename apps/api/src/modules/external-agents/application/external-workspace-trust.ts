/**
 * Whether a vendor may load a workspace's own configuration.
 *
 * Selecting a folder for a chat says where files live. It does **not** say that
 * a third-party CLI may read that folder's rules, project configuration and MCP
 * server definitions and act on them — those are instructions, authored by
 * whoever wrote the repository, that the agent will follow. Opening a Cursor ACP
 * session against a directory does exactly that, with no flag to turn it off, so
 * the decision is surfaced once per `(user, environment, canonical workspace)`
 * and recorded.
 *
 * Two properties this module exists to hold:
 *
 * - **The canonical path is the unit.** A hub-side or client-side spelling of a
 *   directory would let the same workspace be trusted under two names, and the
 *   check that matters happens where the vendor is actually started. So the
 *   runtime's own `paths.canonical` produces the string that is both checked and
 *   stored, and the client never composes one.
 * - **Absence is never consent.** A missing row, a malformed row and a row from
 *   an older disclosure version all mean "ask again". The failure to prefer is
 *   one extra dialog, not a vendor reading a repository nobody agreed to.
 */

import {
  EXTERNAL_WORKSPACE_TRUST_TARGETS,
  type ExternalAgentTargetId,
  needsWorkspaceTrust,
  withWorkspaceTrust,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { writeAppSettings } from '../../app-settings/application/app-settings-service';
import {
  getSavedAppSettings,
  getSavedAppSettingsSnapshot,
} from '../../app-settings/infrastructure/app-settings-repository';

export interface ExternalWorkspaceTrustScope {
  readonly userId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly environmentId: string;
  /** As the machine that runs the vendor spells it. Never a client-supplied path. */
  readonly workspacePath: string;
}

/** Whether this target needs the disclosure at all, before any read happens. */
export function targetLoadsWorkspaceConfiguration(targetId: ExternalAgentTargetId): boolean {
  return EXTERNAL_WORKSPACE_TRUST_TARGETS.includes(targetId);
}

export async function requiresWorkspaceTrust(
  scope: ExternalWorkspaceTrustScope,
  db: Kysely<Database>
): Promise<boolean> {
  if (!targetLoadsWorkspaceConfiguration(scope.targetId)) return false;
  // `getSavedAppSettings` rather than `getAppSettings`, for the reason the turn
  // configuration resolver gives: the latter first awaits
  // `libraryLocationDefaults()`, which probes every agent CLI on the machine
  // when its cache is cold. This gate runs on the send path, in front of a user
  // who is watching, and the only field read here is `workspaceTrust` — which
  // the probe has nothing to say about. Reading the row directly keeps a cold
  // cache from turning every Cursor send into a multi-second stall.
  const settings = await getSavedAppSettings(db, scope.userId);
  return needsWorkspaceTrust(settings.externalAgentSettings.workspaceTrust, {
    targetId: scope.targetId,
    environmentId: scope.environmentId,
    workspacePath: scope.workspacePath,
  });
}

/**
 * Records the acknowledgement, replacing any earlier one for the same key.
 *
 * A target that never loads a workspace's configuration is dropped rather than
 * stored: `requiresWorkspaceTrust` would never read the row back, and the list
 * is capped, so an unreadable row can still evict a grant somebody actually
 * gave — paying for a Codex grant with a Cursor re-prompt.
 *
 * Only the external-agent subtree travels with this acknowledgement. A
 * write that changes the saved snapshot makes this acknowledgement fail with
 * AppSettingsConflict, including a revoked trust entry or another grant. The
 * caller must retry from a fresh read; it cannot restore a trust list derived
 * from an older snapshot. Unrelated preferences survive that fresh retry.
 *
 * @example
 * await grantWorkspaceTrust(scope, db);
 */
export async function grantWorkspaceTrust(
  scope: ExternalWorkspaceTrustScope,
  db: Kysely<Database>,
  now: () => number = Date.now
): Promise<void> {
  if (!targetLoadsWorkspaceConfiguration(scope.targetId)) return;
  // The trust list belongs to externalAgentSettings, whose remaining fields
  // this read preserves. No other settings may travel back with the grant.
  const snapshot = await getSavedAppSettingsSnapshot(db, scope.userId);
  const settings = snapshot.settings;
  const workspaceTrust = withWorkspaceTrust(
    settings.externalAgentSettings.workspaceTrust,
    {
      targetId: scope.targetId,
      environmentId: scope.environmentId,
      workspacePath: scope.workspacePath,
    },
    now()
  );
  await writeAppSettings(
    db,
    scope.userId,
    {
      externalAgentSettings: { ...settings.externalAgentSettings, workspaceTrust },
    },
    snapshot.revision
  );
}
