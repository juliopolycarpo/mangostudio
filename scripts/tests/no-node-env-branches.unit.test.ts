import { describe, expect, it } from 'bun:test';
import {
  assertNoProductionNodeEnvBranches,
  findDisallowedNodeEnvReads,
  NODE_ENV_READ_ALLOWLIST,
} from '../lib/no-node-env-branches';

describe('production NODE_ENV guard', () => {
  it('rejects direct and bracket access outside the allowlist', () => {
    const violations = findDisallowedNodeEnvReads([
      {
        path: 'apps/api/src/new-service.ts',
        content:
          'const mode = process.env.NODE_ENV;\n' +
          'const other = process.env["NODE_ENV"];\n' +
          'const { NODE_ENV } = process.env;',
      },
    ]);

    expect(violations.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'apps/api/src/new-service.ts', line: 1 },
      { path: 'apps/api/src/new-service.ts', line: 2 },
      { path: 'apps/api/src/new-service.ts', line: 3 },
    ]);
  });

  it('does not exempt another read in an allowlisted file', () => {
    expect(
      findDisallowedNodeEnvReads([
        {
          path: 'apps/api/src/lib/config.ts',
          content: 'const mode = process.env.NODE_ENV;',
        },
      ])
    ).toHaveLength(1);
  });

  it('keeps intentional exceptions reasoned and accepted', () => {
    expect(NODE_ENV_READ_ALLOWLIST.every(({ reason }) => reason.length > 0)).toBe(true);
    expect(NODE_ENV_READ_ALLOWLIST).toHaveLength(3);
  });

  it('passes against the current production source tree', () => {
    expect(() => assertNoProductionNodeEnvBranches()).not.toThrow();
  });
});
