import { describe, expect, it } from 'bun:test';
import type { LibraryResource } from '@mangostudio/shared/library';
import { Value } from '@sinclair/typebox/value';
import { parseLibraryArgs } from '../../../src/cli/args';
import {
  CliLibraryLocationsSchema,
  CliLibrarySnapshotSchema,
  runLibrary,
} from '../../../src/cli/commands/library';
import { CliError } from '../../../src/cli/errors';

const divergentResource: LibraryResource = {
  key: 'skill/demo',
  ref: { kind: 'skill', slug: 'demo' },
  instances: [],
  coverage: [],
  divergence: 'divergent',
  contentGroups: [],
  whitespaceOnlyDivergence: false,
};

const uniformResource: LibraryResource = {
  key: 'skill/other',
  ref: { kind: 'skill', slug: 'other' },
  instances: [],
  coverage: [],
  divergence: 'uniform',
  contentGroups: [],
  whitespaceOnlyDivergence: false,
};

describe('parseLibraryArgs', () => {
  it('parses --divergent and --kind', () => {
    expect(parseLibraryArgs(['--divergent', '--kind', 'skill'])).toEqual({
      subcommand: null,
      kind: 'skill',
      divergent: true,
      json: false,
    });
  });

  it('rejects unknown kinds', () => {
    expect(() => parseLibraryArgs(['--kind', 'agent'])).toThrow(CliError);
  });
});

describe('runLibrary', () => {
  it('lists only divergent resources when --divergent is set', async () => {
    const lines: string[] = [];
    await runLibrary(
      { subcommand: null, kind: undefined, divergent: true, json: false },
      {
        discoverResources: async () => [divergentResource, uniformResource],
        listLocations: () => [],
        log: (line) => lines.push(line),
      }
    );

    const output = lines.join('\n');
    expect(output).toContain('skill/demo');
    expect(output).not.toContain('skill/other');
  });

  it('emits schema-valid JSON for locations', async () => {
    const lines: string[] = [];
    await runLibrary(
      { subcommand: 'locations', kind: undefined, divergent: false, json: true },
      {
        discoverResources: async () => [],
        listLocations: () => [
          {
            id: 'mango-skills',
            kind: 'skill',
            scope: 'home',
            path: '/skills',
            access: 'read-write',
            exists: true,
            readable: true,
            writable: true,
            targetIds: ['mangostudio'],
          },
        ],
        log: (line) => lines.push(line),
      }
    );

    const payload = JSON.parse(lines.join('\n'));
    expect(Value.Check(CliLibraryLocationsSchema, payload)).toBe(true);
  });

  it('emits schema-valid JSON snapshot', async () => {
    const lines: string[] = [];
    await runLibrary(
      { subcommand: null, kind: undefined, divergent: false, json: true },
      {
        discoverResources: async () => [uniformResource],
        listLocations: () => [],
        log: (line) => lines.push(line),
      }
    );

    const payload = JSON.parse(lines.join('\n'));
    expect(Value.Check(CliLibrarySnapshotSchema, payload)).toBe(true);
  });
});
