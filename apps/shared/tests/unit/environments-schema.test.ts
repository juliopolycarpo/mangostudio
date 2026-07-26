import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  type RuntimeStatus,
  RuntimeStatusSchema,
  type VersionManagerStatus,
  VersionManagerStatusSchema,
} from '../../src/environments';

describe('RuntimeStatusSchema', () => {
  it('validates coded runtime findings and installation metadata', () => {
    const status: RuntimeStatus = {
      id: 'node',
      health: 'warn',
      installations: [
        {
          path: '/opt/node-v22/bin/node',
          rawPath: '/usr/local/bin/node',
          version: 'v22.13.0',
          origin: 'version-manager',
          pathIndex: 0,
          effective: true,
          managedBy: 'nvm',
        },
      ],
      effective: {
        path: '/opt/node-v22/bin/node',
        rawPath: '/usr/local/bin/node',
        version: 'v22.13.0',
        origin: 'version-manager',
        pathIndex: 0,
        effective: true,
        managedBy: 'nvm',
      },
      findings: [
        {
          code: 'shadowed-by-earlier-path',
          params: {
            effectivePath: '/usr/local/bin/node',
            shadowedPath: '/usr/bin/node',
          },
        },
      ],
      installable: false,
      probedAtMs: 1_700_000_000_000,
    };

    expect(Value.Check(RuntimeStatusSchema, status)).toBe(true);
    expect(
      Value.Check(RuntimeStatusSchema, {
        ...status,
        findings: [{ code: 'english sentence from the API' }],
      })
    ).toBe(false);
  });
});

describe('VersionManagerStatusSchema', () => {
  it('validates managed versions and LTS policy metadata', () => {
    const status: VersionManagerStatus = {
      id: 'nvm',
      installed: true,
      root: '/home/tester/.nvm',
      managerVersion: '0.40.6',
      versions: [
        {
          version: '24.18.0',
          path: '/home/tester/.nvm/versions/node/v24.18.0/bin/node',
          isDefault: true,
          isCurrent: false,
          ltsStatus: 'current-lts',
          ltsCodename: 'krypton',
        },
      ],
      defaultAlias: 'lts/*',
      defaultVersion: '24.18.0',
      findings: [{ code: 'managed-but-not-on-path', params: { manager: 'nvm' } }],
    };

    expect(Value.Check(VersionManagerStatusSchema, status)).toBe(true);
    expect(
      Value.Check(VersionManagerStatusSchema, {
        ...status,
        versions: [{ ...status.versions[0], ltsStatus: 'green-ish' }],
      })
    ).toBe(false);
  });
});
