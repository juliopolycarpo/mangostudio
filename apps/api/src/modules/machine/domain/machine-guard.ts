/**
 * Whether a request may restart this hub or change its service unit. The
 * question is the local-surface one installs already ask — is the browser at
 * this keyboard, and is this machine one worth changing — minus the install
 * switch: restarting the process you are talking to is not the install
 * surface's risk class.
 */

import type { InstallGuard } from '@mangostudio/shared/environments';
import { evaluateInstallGuard } from '../../environments/domain/install-guards';

export interface MachineGuardContext {
  readonly serverHost: string;
  readonly clientIp: string | undefined;
  readonly standalone: boolean;
  readonly container: boolean;
}

/** Evaluate the machine-action guard. // Usage: evaluateMachineActionGuard({ serverHost, clientIp, standalone, container }) */
export function evaluateMachineActionGuard(context: MachineGuardContext): InstallGuard {
  return evaluateInstallGuard({ ...context, installsEnabled: true });
}
