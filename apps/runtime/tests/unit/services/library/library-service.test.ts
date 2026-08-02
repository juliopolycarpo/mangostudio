/**
 * Contained library reads and byte-cap enforcement on the runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import {
  createLibraryService,
  LibraryCache,
  MAX_LIBRARY_FILE_BYTES,
  readLibraryContent,
} from '../../../../src/services/library';
import { createRuntimePathEnv } from '../../../../src/services/probing/host-env';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-runtime-library-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('library.read containment', () => {
  it('throws when the path escapes the registered roots', async () => {
    const inside = join(root, 'skills');
    const outside = join(root, 'outside.txt');
    mkdirSync(inside);
    writeFileSync(outside, 'secret');

    await expect(
      readLibraryContent({
        path: outside,
        allowedRoots: [inside],
      })
    ).rejects.toMatchObject({ code: 'LIBRARY_READ_DENIED' });
  });

  it('reads a file that sits inside an allowed root', async () => {
    const inside = join(root, 'skills');
    const file = join(inside, 'ok.md');
    mkdirSync(inside);
    writeFileSync(file, 'hello');

    const result = await readLibraryContent({
      path: file,
      allowedRoots: [inside],
    });
    expect(result).toEqual({ content: 'hello', truncated: false, sizeBytes: 5 });
  });
});

describe('library.scan caps', () => {
  it('marks an oversized single-file instance as too-large without reading it', async () => {
    const settingsFile = join(root, 'config.toml');
    writeFileSync(settingsFile, `note = "${'x'.repeat(MAX_LIBRARY_FILE_BYTES)}"\n`);

    const service = createLibraryService({
      createPathEnv: () => createRuntimePathEnv(),
      cache: new LibraryCache(),
      describeLocations: () => [],
      now: () => 0,
    });

    const settings = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      home: { 'mango-settings': true },
      workspace: {},
    });

    const result = await service.scan({
      locationSettings: libraryLocationsFor(settings),
      force: true,
      locationPathOverrides: { 'mango-settings': settingsFile },
    });

    expect(result.entries).toHaveLength(1);
    const instance = result.entries[0]?.instance;
    expect(instance?.valid).toBe(false);
    expect(instance?.valid === false && instance.invalidReason).toBe('too-large');
  });
});

describe('library.scan environments stay disjoint', () => {
  it('does not share scan memos across distinct path signatures', async () => {
    const homeA = join(root, 'a');
    const homeB = join(root, 'b');
    mkdirSync(join(homeA, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(homeB, 'skills', 'beta'), { recursive: true });
    writeFileSync(
      join(homeA, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: A\n---\n'
    );
    writeFileSync(
      join(homeB, 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: B\n---\n'
    );

    const cache = new LibraryCache();
    const settings = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      home: { 'mango-skills': true },
      workspace: {},
    });
    const locationSettings = libraryLocationsFor(settings);

    const scanA = await createLibraryService({
      createPathEnv: () => createRuntimePathEnv(),
      cache,
      describeLocations: () => [],
      now: () => 1,
    }).scan({
      locationSettings,
      force: true,
      locationPathOverrides: { 'mango-skills': join(homeA, 'skills') },
    });
    const scanB = await createLibraryService({
      createPathEnv: () => createRuntimePathEnv(),
      cache,
      describeLocations: () => [],
      now: () => 1,
    }).scan({
      locationSettings,
      force: true,
      locationPathOverrides: { 'mango-skills': join(homeB, 'skills') },
    });

    expect(scanA.entries.map((entry) => entry.ref.slug)).toEqual(['alpha']);
    expect(scanB.entries.map((entry) => entry.ref.slug)).toEqual(['beta']);
  });
});
