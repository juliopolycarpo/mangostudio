import { describe, expect, it } from 'bun:test';
import type { PathEnv } from '@mangostudio/shared/runtime-env';

import { RegularFileReadError } from '../../../../src/lib/safe-file';
import {
  inspectAllSettings,
  inspectSettingsTarget,
  type SettingsInspectionFs,
} from '../../../../src/modules/library/application/settings-inspection';

const ENV: PathEnv = {
  platform: 'linux',
  homeDir: '/home/ada',
  env: {},
};

const missingFs: SettingsInspectionFs = {
  readFile() {
    throw new RegularFileReadError('not-found');
  },
  readRulesDirectory() {
    throw new RegularFileReadError('not-found');
  },
};

describe('settings inspection', () => {
  it('reports a missing settings file as absent rather than failed', () => {
    expect(inspectSettingsTarget('mangostudio', { env: ENV, fs: missingFs })).toEqual({
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
    expect(
      inspectAllSettings({ env: ENV, fs: missingFs }).map((snapshot) => snapshot.targetId)
    ).toEqual(['mangostudio', 'claude', 'codex', 'cursor']);
  });

  it('reports malformed shared Claude settings with byte counts from one file read', () => {
    const content = '{"hooks":';
    let readCount = 0;
    const fs: SettingsInspectionFs = {
      readFile() {
        readCount += 1;
        return {
          content,
          sizeBytes: Buffer.byteLength(content),
          truncated: false,
        };
      },
      readRulesDirectory: missingFs.readRulesDirectory,
    };

    expect(inspectSettingsTarget('claude', { env: ENV, fs })).toEqual({
      targetId: 'claude',
      sources: ['claude-settings', 'claude-hooks'].map((locationId, index) => ({
        locationId,
        kind: index === 0 ? 'setting' : 'hook',
        present: true,
        parsed: false,
        sizeBytes: Buffer.byteLength(content),
        failureReason: 'invalid-json',
        fields: [],
      })),
    });
    expect(readCount).toBe(1);
  });

  it('never reads target credential files while inspecting every target', () => {
    const reads: string[] = [];
    const fs: SettingsInspectionFs = {
      readFile(path) {
        reads.push(path);
        const content = path.endsWith('.json') ? '{}' : '';
        return {
          content,
          sizeBytes: Buffer.byteLength(content),
          truncated: false,
        };
      },
      readRulesDirectory(path) {
        reads.push(path);
        return { sources: [], sizeBytes: 0 };
      },
    };

    inspectAllSettings({ env: ENV, fs });

    expect(reads).not.toContain('/home/ada/.codex/auth.json');
    expect(reads).not.toContain('/home/ada/.claude/.credentials.json');
  });
});
