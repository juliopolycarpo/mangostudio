import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { type RuntimeStatus, RuntimeStatusSchema } from '../../src/environments';

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
