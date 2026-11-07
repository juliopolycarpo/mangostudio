import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_APP_SETTINGS, withLibraryLocations } from '@mangostudio/shared/app-settings';
import type { LibraryResource } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import Value from 'typebox/value';

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
  it.each([false, true])('reports a failed location in CLI output (JSON: %s)', async (json) => {
    const home = mkdtempSync(join(tmpdir(), 'library-cli-diagnostics-'));
    const claudeHome = join(home, '.claude');
    const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    const lines: string[] = [];
    try {
      mkdirSync(claudeHome);
      writeFileSync(join(claudeHome, 'skills'), 'not a directory');
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
      const settings = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: { 'claude-skills': true },
        workspace: {},
      });
      await runLibrary(
        { subcommand: null, kind: 'skill', divergent: false, json },
        { getSettings: () => settings, listLocations: () => [], log: (line) => lines.push(line) }
      );
    } finally {
      if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      rmSync(home, { recursive: true, force: true });
    }
    const output = lines.join('\n');
    if (json) {
      const payload = JSON.parse(output);
      expect(Value.Check(CliLibrarySnapshotSchema, payload)).toBe(true);
      expect(payload.locationDiagnostics).toEqual([
        { locationId: 'claude-skills', reason: 'not-directory' },
      ]);
    } else {
      expect(output).toContain('claude-skills: scan failed (not-directory)');
      expect(output).not.toContain('(none)');
    }
  });

  it('shows incomplete precedence while retaining the observed fallback', async () => {
    const resource: LibraryResource = {
      ...uniformResource,
      instances: [
        {
          locationId: 'claude-skills',
          path: '/claude/skills/other',
          modifiedAtMs: 1,
          format: 'markdown-frontmatter',
          valid: true,
          contentHash: 'observed',
          sizeBytes: 1,
        },
      ],
    };
    const lines: string[] = [];
    await runLibrary(
      { subcommand: null, kind: 'skill', divergent: false, json: false },
      {
        discoverScan: () =>
          Promise.resolve({
            resources: [resource],
            unreadableEntries: [],
            locationDiagnostics: [{ locationId: 'agents-skills', reason: 'permission-denied' }],
          }),
        log: (line) => lines.push(line),
      }
    );

    const row = lines.find((line) => line.includes('skill/other'));
    expect(row).toContain('mangostudio:scan-incomplete');
    expect(row).toContain('claude:present');
  });

  it('lists only divergent resources when --divergent is set', async () => {
    const lines: string[] = [];
    await runLibrary(
      { subcommand: null, kind: undefined, divergent: true, json: false },
      {
        discoverScan: () =>
          Promise.resolve({
            resources: [divergentResource, uniformResource],
            unreadableEntries: [],
          }),
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
        discoverScan: () => Promise.resolve({ resources: [], unreadableEntries: [] }),
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
        discoverScan: () =>
          Promise.resolve({ resources: [uniformResource], unreadableEntries: [] }),
        listLocations: () => [],
        log: (line) => lines.push(line),
      }
    );

    const payload = JSON.parse(lines.join('\n'));
    expect(Value.Check(CliLibrarySnapshotSchema, payload)).toBe(true);
    expect(payload).toEqual({ resources: [uniformResource], locations: [] });
  });
});
