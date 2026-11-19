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
  type ExternalWorkspaceTrust,
  needsWorkspaceTrust,
  withoutWorkspaceTrust,
  withWorkspaceTrust,
} from '@mangostudio/shared/external-agents';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { writeAppSettings } from '../../app-settings/application/app-settings-service';
import {
  getSavedAppSettings,
  getSavedAppSettingsSnapshot,
} from '../../app-settings/infrastructure/app-settings-repository';

const logger = createDiagnosticLogger('external-workspace-trust');

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
  logger.info('workspace_trust_granted', auditFields(scope));
}

/**
 * The grants that currently let a turn through, newest first, for the settings
 * page that lists and withdraws them.
 *
 * A row from an older text version is left out: the gate already treats it as
 * "ask again", so listing it as trusted would show a consent nothing honors.
 * Reads the saved row directly, for the reason `requiresWorkspaceTrust` gives.
 */
export async function listWorkspaceTrust(
  userId: string,
  db: Kysely<Database>
): Promise<readonly ExternalWorkspaceTrust[]> {
  const settings = await getSavedAppSettings(db, userId);
  return settings.externalAgentSettings.workspaceTrust
    .filter((entry) => !needsWorkspaceTrust([entry], entry))
    .sort((left, right) => right.acceptedAt - left.acceptedAt);
}

/**
 * Withdraws one grant. Returns whether there was one to withdraw.
 *
 * The scope is the stored key, matched literally. It is never run through the
 * runtime's `paths.canonical`: that needs the machine to answer, and a grant must
 * stay revocable exactly when the machine is offline. The user is part of the
 * scope because the list lives in that user's own settings row, so another
 * user's grant for the same folder is not reachable from here.
 *
 * What this does and does not stop. Absence is never consent, so the next turn
 * in this workspace is refused and asks again — the gate runs on every send, even
 * when a warm session exists. A turn that is already running keeps running: the
 * vendor loaded that folder's configuration when the session opened, and
 * killing the turn would not unload it, only discard the user's work for a
 * decision that is about what happens next. This is deliberately unlike
 * withdrawing a vendor disclosure, which reaps live sessions because it refuses
 * the conversation going to the vendor at all.
 *
 * Like the grant, this is one read-modify-write guarded by the snapshot
 * revision. A concurrent settings write fails it with AppSettingsConflict, and
 * the caller retries from a fresh read.
 *
 * @example
 * const removed = await revokeWorkspaceTrust(scope, db);
 */
export async function revokeWorkspaceTrust(
  scope: ExternalWorkspaceTrustScope,
  db: Kysely<Database>
): Promise<boolean> {
  const snapshot = await getSavedAppSettingsSnapshot(db, scope.userId);
  const settings = snapshot.settings;
  const current = settings.externalAgentSettings.workspaceTrust;
  const workspaceTrust = withoutWorkspaceTrust(current, scope);
  if (workspaceTrust.length === current.length) return false;
  await writeAppSettings(
    db,
    scope.userId,
    {
      externalAgentSettings: { ...settings.externalAgentSettings, workspaceTrust },
    },
    snapshot.revision
  );
  logger.info('workspace_trust_revoked', auditFields(scope));
  return true;
}

/** What a grant or a revocation records: who, for which vendor, where, and on which machine. */
function auditFields(scope: ExternalWorkspaceTrustScope) {
  return {
    userId: scope.userId,
    targetId: scope.targetId,
    environmentId: scope.environmentId,
    workspacePath: scope.workspacePath,
  };
}
