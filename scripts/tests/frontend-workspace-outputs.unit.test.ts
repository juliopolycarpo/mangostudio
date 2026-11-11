import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { buildWithCleanFrontendOutputs } from '../lib/frontend-workspace-outputs';

class FakeFrontendWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), 'mango-frontend-workspace-'));
  readonly frontend = join(this.root, 'apps/frontend');
  readonly dist = join(this.frontend, 'dist');
  readonly entry = join(this.dist, 'index.html');
  readonly obsolete = join(this.dist, 'obsolete.js');
  readonly metafile = join(this.frontend, 'dist-metafile.json');

  constructor() {
    mkdirSync(this.dist, { recursive: true });
    writeFileSync(this.entry, 'previous entry');
    writeFileSync(this.obsolete, 'previous chunk');
    writeFileSync(this.metafile, 'previous metafile');
  }

  restoreFromCache = (): number => {
    expect(readdirSync(this.dist), 'expected an empty cache destination').toEqual([]);
    writeFileSync(this.entry, 'cached entry');
    writeFileSync(this.metafile, 'cached metafile', { flag: 'wx' });
    return 0;
  };

  restoreIndexDirectory = (): number => {
    mkdirSync(this.entry);
    writeFileSync(this.metafile, 'cached metafile');
    return 0;
  };

  restoreMetafileDirectory = (): number => {
    writeFileSync(this.entry, 'cached entry');
    mkdirSync(this.metafile);
    writeFileSync(join(this.metafile, 'unexpected.json'), 'invalid replay output');
    return 0;
  };

  failDuringCacheRestore = (): number => {
    writeFileSync(this.entry, 'partially restored entry');
    writeFileSync(this.metafile, 'partially restored metafile');
    return 7;
  };

  publishWithoutMetafile = (): number => {
    renameSync(this.dist, join(this.frontend, 'empty-cache-destination'));
    mkdirSync(this.dist);
    writeFileSync(this.entry, 'compiler entry');
    return 9;
  };

  publishFromCompiler = (): number => {
    const exitCode = this.publishWithoutMetafile();
    writeFileSync(this.metafile, 'compiler metafile');
    return exitCode;
  };

  publishMetafileDirectory = (): number => {
    const exitCode = this.publishWithoutMetafile();
    mkdirSync(this.metafile);
    return exitCode;
  };

  replaceOnlyMetafile = (): number => {
    renameSync(this.dist, join(this.frontend, 'empty-cache-destination'));
    writeFileSync(this.metafile, 'replacement metafile');
    return 7;
  };

  savedOutputs = (): string[] =>
    readdirSync(this.frontend).filter((name) => name.startsWith('.dist-backup-'));
}

let workspace: FakeFrontendWorkspace;

beforeEach(() => {
  workspace = new FakeFrontendWorkspace();
});

afterEach(() => {
  rmSync(workspace.root, { recursive: true, force: true });
});

describe('frontend workspace cache outputs', () => {
  test('publishes a clean cache hit without retaining a previous chunk', async () => {
    expect(await buildWithCleanFrontendOutputs(workspace.root, workspace.restoreFromCache)).toBe(0);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('cached entry');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('cached metafile');
    expect(existsSync(workspace.obsolete), 'expected obsolete chunk removed').toBe(false);
    expect(
      readdirSync(workspace.frontend).filter((name) => name.startsWith('.dist-backup-'))
    ).toEqual([]);
  });

  test('restores the previous bundle and metafile after a partial cache replay', async () => {
    expect(
      await buildWithCleanFrontendOutputs(workspace.root, workspace.failDuringCacheRestore)
    ).toBe(7);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(readFileSync(workspace.obsolete, 'utf8')).toBe('previous chunk');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('previous metafile');
  });

  test('preserves a complete compiler publication after another task fails', async () => {
    expect(await buildWithCleanFrontendOutputs(workspace.root, workspace.publishFromCompiler)).toBe(
      9
    );
    expect(readFileSync(workspace.entry, 'utf8')).toBe('compiler entry');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('compiler metafile');
    expect(existsSync(workspace.obsolete)).toBe(false);
  });

  test('retains the last complete pair after an incomplete compiler publication', async () => {
    const result = await buildWithCleanFrontendOutputs(
      workspace.root,
      workspace.publishWithoutMetafile
    ).catch((error: unknown) => error);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('compiler entry');
    const backups = workspace.savedOutputs();
    expect(backups, 'expected a retained backup of the previous pair').toHaveLength(1);
    const backup = join(workspace.frontend, backups[0] ?? '');
    expect(readFileSync(join(backup, 'dist/index.html'), 'utf8')).toBe('previous entry');
    expect(readFileSync(join(backup, 'dist-metafile.json'), 'utf8')).toBe('previous metafile');
    expect(result).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(`received missing file ${workspace.metafile}`),
      })
    );
  });

  test('checks all rollback destinations before restoring either output', async () => {
    const result = await buildWithCleanFrontendOutputs(
      workspace.root,
      workspace.replaceOnlyMetafile
    ).catch((error: unknown) => error);
    expect(existsSync(workspace.dist), 'expected the saved bundle to stay in its backup').toBe(
      false
    );
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('replacement metafile');
    const backups = workspace.savedOutputs();
    expect(backups, 'expected a retained backup of the previous pair').toHaveLength(1);
    const backup = join(workspace.frontend, backups[0] ?? '');
    expect(readFileSync(join(backup, 'dist/index.html'), 'utf8')).toBe('previous entry');
    expect(readFileSync(join(backup, 'dist-metafile.json'), 'utf8')).toBe('previous metafile');
    expect(result).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(`received occupied path ${workspace.metafile}`),
      })
    );
  });

  test('rejects a successful command that left an incomplete frontend output', async () => {
    const restoreOnlyMetafile = (): number => {
      writeFileSync(workspace.metafile, 'incomplete replay');
      return 0;
    };

    await expect(
      buildWithCleanFrontendOutputs(workspace.root, restoreOnlyMetafile)
    ).rejects.toThrow(`received missing file ${workspace.entry}`);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('previous metafile');
  });

  test('rejects a cache replay that creates a directory in place of the entry file', async () => {
    await expect(
      buildWithCleanFrontendOutputs(workspace.root, workspace.restoreIndexDirectory)
    ).rejects.toThrow(`received non-file ${workspace.entry}`);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('previous metafile');
  });

  test('restores the previous pair when a cache replay creates a metafile directory', async () => {
    await expect(
      buildWithCleanFrontendOutputs(workspace.root, workspace.restoreMetafileDirectory)
    ).rejects.toThrow(`received non-file ${workspace.metafile}`);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(readFileSync(workspace.obsolete, 'utf8')).toBe('previous chunk');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('previous metafile');
    expect(workspace.savedOutputs()).toEqual([]);
  });

  test('keeps the last complete pair when a replacement metafile is a directory', async () => {
    await expect(
      buildWithCleanFrontendOutputs(workspace.root, workspace.publishMetafileDirectory)
    ).rejects.toThrow(`received non-file ${workspace.metafile}`);
    const backups = workspace.savedOutputs();
    expect(backups, 'expected a retained backup of the previous pair').toHaveLength(1);
    const backup = join(workspace.frontend, backups[0] ?? '');
    expect(readFileSync(join(backup, 'dist/index.html'), 'utf8')).toBe('previous entry');
    expect(readFileSync(join(backup, 'dist-metafile.json'), 'utf8')).toBe('previous metafile');
  });

  test('restores the previous pair when the runner exits during a cache replay', () => {
    const interruptedReplay = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { buildWithCleanFrontendOutputs } from './scripts/lib/frontend-workspace-outputs';
      const root = process.argv[1];
      await buildWithCleanFrontendOutputs(root, () => {
        writeFileSync(join(root, 'apps/frontend/dist/index.html'), 'interrupted replay');
        writeFileSync(join(root, 'apps/frontend/dist-metafile.json'), 'interrupted metadata');
        process.exit(143);
      });
    `;
    const child = Bun.spawnSync([process.execPath, '-e', interruptedReplay, workspace.root], {
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode, child.stderr.toString()).toBe(143);
    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(readFileSync(workspace.metafile, 'utf8')).toBe('previous metafile');
  });

  test('keeps a second workspace build away from an active replay', async () => {
    const firstBuild = Promise.withResolvers<number>();
    const pauseReplay = () => firstBuild.promise;
    const pending = buildWithCleanFrontendOutputs(workspace.root, pauseReplay);
    try {
      await expect(
        buildWithCleanFrontendOutputs(workspace.root, workspace.restoreFromCache)
      ).rejects.toThrow('received a busy or unavailable build lock');
    } finally {
      firstBuild.resolve(5);
      expect(await pending).toBe(5);
    }

    expect(readFileSync(workspace.entry, 'utf8')).toBe('previous entry');
    expect(await buildWithCleanFrontendOutputs(workspace.root, workspace.restoreFromCache)).toBe(0);
  });
});
