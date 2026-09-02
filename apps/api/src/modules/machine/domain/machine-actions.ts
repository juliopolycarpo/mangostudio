/**
 * Which machine actions the page may offer right now, and why not. Pure over
 * the facts the status already carries, so the page and the POST handlers
 * refuse for the same reasons.
 */

import type { InstallGuard } from '@mangostudio/shared/environments';
import type {
  HubLaunchMode,
  MachineAction,
  MachineActionReason,
  MachineActions,
} from '@mangostudio/shared/machine';
import type { UserServiceStatus } from '@mangostudio/shared/runtime-home';

export interface MachineActionsInput {
  readonly launch: HubLaunchMode;
  readonly platform: NodeJS.Platform;
  readonly service: UserServiceStatus;
  readonly guard: InstallGuard;
  /** Whether the auth secret is stored where a unit could load it. */
  readonly secretPersisted: boolean;
}

export const RESTART_COMMAND = 'mangostudio restart';
export const INSTALL_SERVICE_COMMAND = 'mangostudio service install';
export const UNINSTALL_SERVICE_COMMAND = 'mangostudio service uninstall';

function action(command: string, reason: MachineActionReason | null): MachineAction {
  return reason ? { available: false, command, reason } : { available: true, command };
}

export function restartReason(input: MachineActionsInput): MachineActionReason | null {
  if (!input.guard.allowed) return 'guard';
  if (input.launch === 'foreground') return 'foreground';
  if (input.launch === 'service' && input.platform === 'win32') return 'windows-service';
  return null;
}

export function installServiceReason(input: MachineActionsInput): MachineActionReason | null {
  if (!input.guard.allowed) return 'guard';
  if (input.service.platform === 'unsupported') return 'unsupported-platform';
  if (input.service.error) return 'service-unreadable';
  if (input.service.installed) return 'already-installed';
  if (!input.secretPersisted) return 'secret-not-persisted';
  return null;
}

export function uninstallServiceReason(input: MachineActionsInput): MachineActionReason | null {
  if (!input.guard.allowed) return 'guard';
  if (input.service.platform === 'unsupported') return 'unsupported-platform';
  if (input.service.error) return 'service-unreadable';
  if (!input.service.installed) return 'not-installed';
  // Unregistering does not end the running instance, and stopping it from
  // inside its own process tree ends the caller first.
  if (input.launch === 'service' && input.platform === 'win32') return 'windows-service';
  return null;
}

/** The three actions with their availability. // Usage: machineActions({ launch, platform, service, guard, secretPersisted }) */
export function machineActions(input: MachineActionsInput): MachineActions {
  return {
    guard: input.guard,
    restart: action(RESTART_COMMAND, restartReason(input)),
    installService: action(INSTALL_SERVICE_COMMAND, installServiceReason(input)),
    uninstallService: action(UNINSTALL_SERVICE_COMMAND, uninstallServiceReason(input)),
  };
}
