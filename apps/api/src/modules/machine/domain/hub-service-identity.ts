/**
 * How the hub's own service unit is named under each supervisor, and the env
 * marker the unit sets so the serving process knows a supervisor owns it.
 * Kept free of imports so the server bootstrap can read the marker without
 * pulling the service manager in.
 */

import type { UserServiceIdentity } from '@mangostudio/runtime';

export const HUB_SERVICE_DOCS_URL =
  'https://github.com/juliopolycarpo/mangostudio/blob/main/docs/reference/cli.md#service';

export const HUB_SERVICE_IDENTITY: UserServiceIdentity = {
  unitName: 'mangostudio.service',
  launchdLabel: 'com.mangostudio.hub',
  taskName: 'MangoStudio Hub',
  cliName: 'mangostudio',
  docsUrl: HUB_SERVICE_DOCS_URL,
};

/** Set in the unit's environment; its value is the unit's name on that platform. */
export const HUB_SERVICE_UNIT_ENV = 'MANGOSTUDIO_SERVICE_UNIT';

/** The unit's name under this platform's supervisor. // Usage: hubServiceUnitName('linux') */
export function hubServiceUnitName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return HUB_SERVICE_IDENTITY.launchdLabel;
  if (platform === 'win32') return HUB_SERVICE_IDENTITY.taskName;
  return HUB_SERVICE_IDENTITY.unitName;
}
