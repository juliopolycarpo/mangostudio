/**
 * What the workspace-trust gate is allowed to cost.
 *
 * The gate runs on the send path, in front of a user watching a composer, and
 * the only thing it reads is one field of the settings row. Reading it through
 * `getAppSettings` would first await `libraryLocationDefaults()`, which probes
 * every agent CLI on the machine when its cache is cold — a multi-second stall
 * bought for an answer the probe has nothing to say about.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { getDb } from '../../../../src/db/database';
import { setLibraryLocationDefaultsForTest } from '../../../../src/modules/app-settings/application/app-settings-service';
import { environmentProbingService } from '../../../../src/modules/environments/application/probing-service';
import { requiresWorkspaceTrust } from '../../../../src/modules/external-agents/application/external-workspace-trust';

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
