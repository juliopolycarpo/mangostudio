import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLibraryLocation, type PathEnv } from '../../../../src/modules/library/domain/registry';
import {
  findStagedRemovalLeftovers,
  findStagedRemovalsForLocations,
  stagedRemovalDirectory,
  stageResourceRemoval,
} from '../../../../src/modules/library/infrastructure/tree-removal';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-tree-removal-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedTree(name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, 'nested'), { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), 'entrypoint\n');
  writeFileSync(join(path, 'nested', 'asset.txt'), 'asset\n');
  return path;
}

function locationOf(id: string) {
  const location = getLibraryLocation(id);
  if (!location) throw new Error(`Unknown test location: ${id}`);
  return location;
}

const env: PathEnv = { homeDir: '/home/test', platform: 'linux', env: {} };

describe('stageResourceRemoval', () => {
  it('moves the whole tree aside in one step, leaving nothing at the destination', async () => {
    const path = seedTree('gh');

    const staged = await stageResourceRemoval({ resolvedPath: path, suffix: 'abc' });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(staged.stagePath, 'nested', 'asset.txt'))).toBe(true);
  });

  it('puts the tree back byte-for-byte on rollback', async () => {
    const path = seedTree('gh');
    const staged = await stageResourceRemoval({ resolvedPath: path, suffix: 'abc' });

    await staged.rollback();

    expect(readFileSync(join(path, 'nested', 'asset.txt'), 'utf8')).toBe('asset\n');
    expect(existsSync(staged.stagePath)).toBe(false);
  });

  it('deletes the staged tree on commit', async () => {
    const path = seedTree('gh');
    const staged = await stageResourceRemoval({ resolvedPath: path, suffix: 'abc' });

    await staged.commit();

    expect(existsSync(staged.stagePath)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to stage over a temp path that is already occupied', async () => {
    const path = seedTree('gh');
    mkdirSync(join(root, '.gh.abc.removing'), { recursive: true });

    await expect(stageResourceRemoval({ resolvedPath: path, suffix: 'abc' })).rejects.toThrow(
      /already exists/
    );
    // The occupied temp tree still holds someone's data, so the destination is
    // left exactly as it was rather than being moved on top of it.
    expect(existsSync(path)).toBe(true);
  });
});

describe('findStagedRemovalLeftovers', () => {
  it('reports a temp tree an interrupted removal left behind', async () => {
    mkdirSync(join(root, '.gh.abc.removing'), { recursive: true });

    const leftovers = await findStagedRemovalLeftovers({
      locationId: 'claude-skills',
      directory: root,
    });

    expect(leftovers).toHaveLength(1);
    expect(leftovers[0].path).toBe(join(root, '.gh.abc.removing'));
  });

  it('ignores ordinary entries and the writer’s own staging siblings', async () => {
    seedTree('gh');
    mkdirSync(join(root, '.gh.abc.staging'), { recursive: true });
    mkdirSync(join(root, '.gh.abc.previous'), { recursive: true });

    expect(
      await findStagedRemovalLeftovers({ locationId: 'claude-skills', directory: root })
    ).toEqual([]);
  });

  it('reports nothing for a location directory that does not exist', async () => {
    expect(
      await findStagedRemovalLeftovers({
        locationId: 'claude-skills',
        directory: join(root, 'missing'),
      })
    ).toEqual([]);
  });
});

describe('stagedRemovalDirectory', () => {
  it('stages beside the destination inside a directory location', () => {
    expect(stagedRemovalDirectory(locationOf('claude-skills'), env)).toBe(
      '/home/test/.claude/skills'
    );
  });

  it('stages in the parent of a single-file location, whose own path is the destination', () => {
    expect(stagedRemovalDirectory(locationOf('claude-instructions'), env)).toBe(
      '/home/test/.claude'
    );
  });
});

describe('findStagedRemovalsForLocations', () => {
  it('reports a shared directory once, not once per location that reads it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mango-tree-removal-home-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(join(home, '.claude', '.CLAUDE.md.abc.removing'), { recursive: true });

      const leftovers = await findStagedRemovalsForLocations(
        [locationOf('claude-instructions'), locationOf('claude-settings')],
        { homeDir: home, platform: 'linux', env: {} }
      );

      expect(leftovers).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
