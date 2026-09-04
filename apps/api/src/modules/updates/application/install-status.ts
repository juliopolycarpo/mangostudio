/**
 * Install origin, effective channel, upgrade plan and command in one place —
 * derived once here rather than separately by `GET /api/machine/update`,
 * `doctor`'s two rows and `status`'s two lines, which must never disagree
 * about what upgrades this install or how.
 */

import type { UpdateChannel, UpgradeRefusalReason } from '@mangostudio/shared/updates';
import {
  detectInstallOrigin,
  type InstallOrigin,
  type InstallOriginProbe,
} from '../domain/install-origin';
import { planUpgrade, type UpgradePlan, upgradeCommandFor } from '../domain/upgrade-plan';

export interface InstallStatus {
  readonly installedVia: InstallOrigin;
  /** The configured channel, or `installedVia.channel` (this build's own) when unset. */
  readonly channel: UpdateChannel;
  readonly plan: UpgradePlan;
  /** What upgrades this install: the manager's own command, or `mangostudio upgrade`. */
  readonly command: string;
}

/**
 * Resolve the install status for the running process.
 * // Usage: resolveInstallStatus(probe, config.updates.channel, getVersion())
 */
export function resolveInstallStatus(
  probe: InstallOriginProbe,
  configuredChannel: UpdateChannel | null,
  currentVersion: string
): InstallStatus {
  const installedVia = detectInstallOrigin(probe);
  const channel = configuredChannel ?? installedVia.channel;
  const plan = planUpgrade(
    installedVia.manager,
    { channel },
    { platform: probe.platform, currentVersion }
  );
  return { installedVia, channel, plan, command: upgradeCommandFor(plan, channel) };
}

/** `'package-manager'` for a delegate plan, the refusal's own reason, or undefined for `self`. */
export function upgradeRefusalReason(plan: UpgradePlan): UpgradeRefusalReason | undefined {
  if (plan.kind === 'self') return undefined;
  if (plan.kind === 'delegate') return 'package-manager';
  return plan.reason;
}
