/**
 * Contained library reads and byte-cap enforcement on the runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { createPathEnv } from '@mangostudio/shared/runtime-env';
import {
  createLibraryService,
  LibraryCache,
  MAX_LIBRARY_FILE_BYTES,
  readLibraryContent,
} from '../../../../src/services/library';
import { readLibraryTree } from '../../../../src/services/library/instance-reader';
import { createRuntimePathEnv } from '../../../../src/services/probing/host-env';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-runtime-library-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('library.read containment', () => {
  it('throws when the path escapes the location root', async () => {
    const inside = join(root, 'skills');
    const outside = join(root, 'outside.txt');
    mkdirSync(inside);
    writeFileSync(outside, 'secret');

    await expect(
      readLibraryContent({
        path: outside,
        root: inside,
      })
    ).rejects.toMatchObject({ code: 'LIBRARY_READ_DENIED' });
  });

  it('reads a file that sits inside the location root', async () => {
    const inside = join(root, 'skills');
    const file = join(inside, 'ok.md');
    mkdirSync(inside);
    writeFileSync(file, 'hello');

    const result = await readLibraryContent({
      path: file,
      root: inside,
    });
    expect(result).toEqual({ content: 'hello', truncated: false, sizeBytes: 5 });
  });

  it('denies a symlink whose realpath escapes the location root', async () => {
    const inside = join(root, 'skills');
    const outside = join(root, 'secret.txt');
    mkdirSync(inside);
    writeFileSync(outside, 'secret');
    const link = join(inside, 'escape.md');
    symlinkSync(outside, link);

    await expect(
      readLibraryContent({
        path: link,
        root: inside,
      })
    ).rejects.toMatchObject({ code: 'LIBRARY_READ_DENIED' });
  });

  it('reads through an in-root symlink via the canonical path', async () => {
    const inside = join(root, 'skills');
    mkdirSync(inside);
    const target = join(inside, 'real.md');
    writeFileSync(target, 'canonical');
    const link = join(inside, 'alias.md');
    symlinkSync(target, link);

    const result = await readLibraryContent({
      path: link,
      root: inside,
    });
    expect(result).toEqual({ content: 'canonical', truncated: false, sizeBytes: 9 });
  });

  it('truncates oversize content without loading past the byte cap', async () => {
    const inside = join(root, 'skills');
    const file = join(inside, 'big.md');
    mkdirSync(inside);
    writeFileSync(file, 'abcdefghij');

    const result = await readLibraryContent({
      path: file,
      root: inside,
      maxBytes: 4,
      truncateOversize: true,
    });
    expect(result).toEqual({ content: 'abcd', truncated: true, sizeBytes: 10 });
  });

  it('refuses oversize content when truncation is not requested', async () => {
    const inside = join(root, 'skills');
    const file = join(inside, 'big.md');
    mkdirSync(inside);
    writeFileSync(file, 'abcdefghij');

    await expect(
      readLibraryContent({
        path: file,
        root: inside,
        maxBytes: 4,
      })
    ).rejects.toMatchObject({ code: 'LIBRARY_READ_DENIED' });
  });
});

/**
 * The hub names a location; the root comes from this host. A single-file
 * location resolves to the file itself, so its boundary has to be the agent
 * home around it — otherwise every symlinked `CLAUDE.md` passes containment
 * against its own target.
 */
describe('library.read resolves its own root from the location', () => {
  const serviceWithHome = (homeDir: string) =>
    createLibraryService({
      createPathEnv: () => createPathEnv({ platform: process.platform, homeDir, env: {} }),
      cache: new LibraryCache(),
      describeLocations: () => [],
      now: () => 0,
    });

  it('denies a single-file instance symlinked outside its agent home', async () => {
    const claudeHome = join(root, '.claude');
    mkdirSync(claudeHome, { recursive: true });
    const outside = join(root, 'passwd');
    writeFileSync(outside, 'root:x:0:0');
    const instructions = join(claudeHome, 'CLAUDE.md');
    symlinkSync(outside, instructions);

    const result = await serviceWithHome(root).read({
      path: instructions,
      locationId: 'claude-instructions',
    });
    expect(result.denied).toBe(true);
    expect(result.content).toBe('');
  });

  it('reads a single-file instance symlinked within its agent home', async () => {
    const claudeHome = join(root, '.claude');
    mkdirSync(claudeHome, { recursive: true });
    const target = join(claudeHome, 'shared.md');
    writeFileSync(target, 'shared');
    const instructions = join(claudeHome, 'CLAUDE.md');
    symlinkSync(target, instructions);

    const result = await serviceWithHome(root).read({
      path: instructions,
      locationId: 'claude-instructions',
    });
    expect(result.denied).toBeUndefined();
    expect(result.content).toBe('shared');
  });

  it('denies a path that names a location it does not sit under', async () => {
    const claudeHome = join(root, '.claude');
    mkdirSync(claudeHome, { recursive: true });
    const elsewhere = join(root, 'elsewhere.md');
    writeFileSync(elsewhere, 'nope');

    const result = await serviceWithHome(root).read({
      path: elsewhere,
      locationId: 'claude-instructions',
    });
    expect(result.denied).toBe(true);
  });
});

describe('library.scan caps', () => {
  it('marks an oversized single-file instance as too-large without reading it', async () => {
    const settingsFile = join(root, 'config.toml');
    writeFileSync(settingsFile, `note = "${'x'.repeat(MAX_LIBRARY_FILE_BYTES)}"\n`);

    // Pin PathEnv to the fixture home: mango-agents/mango-skills stay
    // force-enabled by the normalizer and must not scan the developer machine.
    const service = createLibraryService({
      createPathEnv: () => createPathEnv({ platform: process.platform, homeDir: root, env: {} }),
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
    // Second scan must not use force: force bypasses the scan memo, so a
    // colliding cache key would never be observed.
    const scanB = await createLibraryService({
      createPathEnv: () => createRuntimePathEnv(),
      cache,
      describeLocations: () => [],
      now: () => 1,
    }).scan({
      locationSettings,
      force: false,
      locationPathOverrides: { 'mango-skills': join(homeB, 'skills') },
    });

    expect(scanA.entries.map((entry) => entry.ref.slug)).toEqual(['alpha']);
    expect(scanB.entries.map((entry) => entry.ref.slug)).toEqual(['beta']);
  });

  it('does not cancel a coalesced scan when a different caller aborts', async () => {
    const skills = join(root, 'skills', 'alpha');
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, 'SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');

    const cache = new LibraryCache();
    const settings = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      home: { 'mango-skills': true },
      workspace: {},
    });
    const params = {
      locationSettings: libraryLocationsFor(settings),
      force: false,
      locationPathOverrides: { 'mango-skills': join(root, 'skills') },
    };
    const service = createLibraryService({
      createPathEnv: () => createRuntimePathEnv(),
      cache,
      describeLocations: () => [],
      now: () => 1,
    });

    const firstController = new AbortController();
    const first = service.scan(params, firstController.signal);
    const second = service.scan(params, new AbortController().signal);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((await second).entries.map((entry) => entry.ref.slug)).toEqual(['alpha']);
  });
});

describe('library.read-tree cancellation', () => {
  it('refuses after a file read that was cancelled while in flight', async () => {
    const file = join(root, 'note.md');
    writeFileSync(file, 'hello');
    const controller = new AbortController();

    await expect(
      readLibraryTree(file, root, {
        signal: controller.signal,
        fs: {
          readDirectory: async () => [],
          realPath: async (path) => path,
          stat: async () => ({ size: 5, mtimeMs: 0, isFile: true, isDirectory: false }),
          readFile: () => {
            controller.abort();
            return Promise.resolve(new Uint8Array([1]));
          },
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
