/**
 * What the workspace-trust gate is allowed to cost.
 *
 * The gate runs on the send path, in front of a user watching a composer, and
 * the only thing it reads is one field of the settings row. Reading it through
 * `getAppSettings` would first await `libraryLocationDefaults()`, which probes
 * every agent CLI on the machine when its cache is cold — a multi-second stall
 * bought for an answer the probe has nothing to say about.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { EXTERNAL_WORKSPACE_TRUST_VERSION } from '@mangostudio/shared/external-agents';

import { getDb } from '../../../../src/db/database';
import {
  getAppSettings,
  setLibraryLocationDefaultsForTest,
  updateAppSettings,
} from '../../../../src/modules/app-settings/application/app-settings-service';
import { getSavedAppSettingsSnapshot } from '../../../../src/modules/app-settings/infrastructure/app-settings-repository';
import { environmentProbingService } from '../../../../src/modules/environments/application/probing-service';
import {
  grantWorkspaceTrust,
  listWorkspaceTrust,
  requiresWorkspaceTrust,
  revokeWorkspaceTrust,
} from '../../../../src/modules/external-agents/application/external-workspace-trust';
import { insertTestUser } from '../../../support/factories';

const originalListAgentCliStatuses = environmentProbingService.listAgentCliStatuses;

afterEach(() => {
  // The suite-wide seam the test environment installs, restored so a later
  // suite does not inherit real detection from this one.
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
  environmentProbingService.listAgentCliStatuses = originalListAgentCliStatuses;
});

describe('the workspace trust gate', () => {
  it('answers without probing the machine for agent CLIs', async () => {
    let probes = 0;
    environmentProbingService.listAgentCliStatuses = () => {
      probes += 1;
      return Promise.resolve([]);
    };
    // Real detection, and the seam clears the memoized value with it — so a
    // probe would genuinely run here rather than being served from whatever
    // another suite left in the cache, which is what makes the count mean
    // something.
    setLibraryLocationDefaultsForTest(null);

    const required = await requiresWorkspaceTrust(
      {
        userId: 'workspace-trust-probe',
        targetId: 'cursor',
        environmentId: 'local',
        workspacePath: '/work/repo',
      },
      getDb()
    );

    // Nobody has granted anything, so the gate still has to say yes.
    expect(required).toBe(true);
    expect(probes).toBe(0);
  });
});

describe('listing and revoking workspace trust', () => {
  async function newScope(workspacePath = '/work/repo') {
    const user = await insertTestUser();
    return { userId: user.id, targetId: 'cursor' as const, environmentId: 'local', workspacePath };
  }

  it('lists the newest grant first', async () => {
    const scope = await newScope('/work/older');
    await grantWorkspaceTrust(scope, getDb(), () => 1_000);
    await grantWorkspaceTrust({ ...scope, workspacePath: '/work/newer' }, getDb(), () => 2_000);

    const grants = await listWorkspaceTrust(scope.userId, getDb());

    expect(grants.map((grant) => grant.workspacePath)).toEqual(['/work/newer', '/work/older']);
  });

  it('removes the grant and reports that it was there', async () => {
    const scope = await newScope();
    await grantWorkspaceTrust(scope, getDb());

    expect(await revokeWorkspaceTrust(scope, getDb())).toBe(true);

    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(true);
    expect(await listWorkspaceTrust(scope.userId, getDb())).toEqual([]);
  });

  it('reports false, and writes nothing, when there is no such grant', async () => {
    const scope = await newScope();
    await grantWorkspaceTrust(scope, getDb());
    const before = await getSavedAppSettingsSnapshot(getDb(), scope.userId);

    const removed = await revokeWorkspaceTrust(
      { ...scope, workspacePath: '/work/never-trusted' },
      getDb()
    );

    expect(removed).toBe(false);
    const after = await getSavedAppSettingsSnapshot(getDb(), scope.userId);
    expect(after.revision).toBe(before.revision);
  });

  it('keeps the rest of the external-agent settings when it removes a grant', async () => {
    const scope = await newScope();
    await grantWorkspaceTrust(scope, getDb());
    await updateAppSettings(getDb(), scope.userId, {
      externalAgentSettings: {
        disclosures: {},
        workspaceTrust: (await getAppSettings(getDb(), scope.userId)).externalAgentSettings
          .workspaceTrust,
        defaults: { cursor: { model: 'auto' } },
      },
    });

    await revokeWorkspaceTrust(scope, getDb());

    const settings = await getAppSettings(getDb(), scope.userId);
    expect(settings.externalAgentSettings.defaults).toEqual({ cursor: { model: 'auto' } });
  });

  it('records who withdrew which grant, and records nothing when there was none', async () => {
    const scope = await newScope();
    await grantWorkspaceTrust(scope, getDb());
    const previousSetting = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const lines: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      await revokeWorkspaceTrust({ ...scope, workspacePath: '/work/never-trusted' }, getDb());
      expect(lines).toEqual([]);

      await revokeWorkspaceTrust(scope, getDb());
    } finally {
      warn.mockRestore();
      if (previousSetting === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousSetting;
    }

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scope: 'external-workspace-trust',
      event: 'workspace_trust_revoked',
      metadata: {
        userId: scope.userId,
        targetId: 'cursor',
        environmentId: 'local',
        workspacePath: '/work/repo',
      },
    });
  });

  it('hides a grant from an older text version but still lets it be removed', async () => {
    const scope = await newScope();
    await updateAppSettings(getDb(), scope.userId, {
      externalAgentSettings: {
        disclosures: {},
        workspaceTrust: [
          {
            targetId: scope.targetId,
            environmentId: scope.environmentId,
            workspacePath: scope.workspacePath,
            version: EXTERNAL_WORKSPACE_TRUST_VERSION + 1,
            acceptedAt: 1_000,
          },
        ],
      },
    });

    // The gate already asks again for it, so the list must not call it trusted.
    expect(await listWorkspaceTrust(scope.userId, getDb())).toEqual([]);
    expect(await revokeWorkspaceTrust(scope, getDb())).toBe(true);
  });
});
