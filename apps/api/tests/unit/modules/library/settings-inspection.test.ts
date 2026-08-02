import { describe, expect, it } from 'bun:test';
import type { RuntimeSettingsSource, RuntimeSettingsSourcesResult } from '@mangostudio/runtime';

import {
  inspectAllSettings,
  inspectSettingsTarget,
} from '../../../../src/modules/library/application/settings-inspection';

const HOME = '/home/ada';

/** What the runtime reports for a machine where nothing is configured. */
const nothingThere: RuntimeSettingsSourcesResult = { homeDir: HOME, sources: [] };

function payload(...sources: RuntimeSettingsSource[]): RuntimeSettingsSourcesResult {
  return { homeDir: HOME, sources };
}

describe('settings inspection', () => {
  it('reports a missing settings file as absent rather than failed', () => {
    expect(inspectSettingsTarget('mangostudio', nothingThere)).toEqual({
      targetId: 'mangostudio',
      sources: [
        {
          locationId: 'mango-settings',
          kind: 'setting',
          present: false,
          parsed: false,
          fields: [],
        },
      ],
    });
  });

  it('returns one snapshot for every registered target', () => {
    expect(inspectAllSettings(nothingThere).map((snapshot) => snapshot.targetId)).toEqual([
      'mangostudio',
      'claude',
      'codex',
      'cursor',
    ]);
  });

  it('reports malformed shared Claude settings under both locations', () => {
    const content = '{"hooks":';
    const sizeBytes = Buffer.byteLength(content);
    const snapshot = inspectSettingsTarget(
      'claude',
      payload(
        { locationId: 'claude-settings', present: true, content, sizeBytes },
        { locationId: 'claude-hooks', present: true, content, sizeBytes }
      )
    );

    expect(snapshot).toEqual({
      targetId: 'claude',
      sources: ['claude-settings', 'claude-hooks'].map((locationId, index) => ({
        locationId,
        kind: index === 0 ? 'setting' : 'hook',
        present: true,
        parsed: false,
        sizeBytes,
        failureReason: 'invalid-json',
        fields: [],
      })),
    });
  });

  // The runtime distinguishes "nothing there" from "there and unreadable", and
  // that distinction has to survive into the snapshot: one is an empty row, the
  // other is a file the user needs to go look at.
  it('carries a runtime read failure through as the parse failure', () => {
    const snapshot = inspectSettingsTarget(
      'mangostudio',
      payload({ locationId: 'mango-settings', present: true, failureReason: 'too-large' })
    );

    expect(snapshot.sources).toEqual([
      {
        locationId: 'mango-settings',
        kind: 'setting',
        present: true,
        parsed: false,
        failureReason: 'too-large',
        fields: [],
      },
    ]);
  });
});
