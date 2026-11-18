import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { tarCreationCommand, zipCreationCommand } from '../lib/archive-creation';
import { captureCommand } from '../lib/exec';
import { zipArchiveCommands } from '../lib/zip-archive';
import { assertMaterializedMembers, extractTargetArchive } from '../release/extract-target';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-target-extraction-'));
  tempDirs.push(dir);
  return dir;
}

function stageTarget(sourceDir: string, binary: string): void {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, binary), 'binary', { mode: 0o755 });
  writeFileSync(join(sourceDir, 'README.md'), 'readme');
}

function fileSnapshot(rootDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot[relative(rootDir, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
    }
  };
  visit(rootDir);
  return snapshot;
}

async function runOrThrow(command: readonly string[], cwd?: string): Promise<void> {
  const result = await captureCommand([...command], cwd ? { cwd } : undefined);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

describe('assertMaterializedMembers', () => {
  function layout(files: Record<string, string>): string {
    const root = makeTempDir();
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return root;
  }

  function layoutError(root: string, expectedMembers: readonly string[]): string {
    try {
      assertMaterializedMembers(root, expectedMembers);
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
    throw new Error('expected a Target archive layout mismatch | received: no error');
  }

  test('accepts a tree that matches, including nested members and their parents', () => {
    const root = layout({ 'README.md': 'r', mangostudio: 'b', 'sidecar/bin/tool': 't' });

    expect(() =>
      assertMaterializedMembers(root, ['README.md', 'mangostudio', 'sidecar/bin/tool'])
    ).not.toThrow();
  });

  test('names a member missing from a subtree that still has its top-level directory', () => {
    const root = layout({ 'README.md': 'r', 'sidecar/a.js': 'a' });

    expect(layoutError(root, ['README.md', 'sidecar/a.js', 'sidecar/b.js'])).toBe(
      'Target archive layout mismatch:\nsidecar/b.js: missing file'
    );
  });

  test('names every extra entry, including those under an unexpected directory', () => {
    const root = layout({ 'README.md': 'r', 'stray.txt': 's', 'extra/deep/file': 'x' });

    expect(layoutError(root, ['README.md'])).toBe(
      [
        'Target archive layout mismatch:',
        'extra: unexpected directory',
        'extra/deep: unexpected directory',
        'extra/deep/file: unexpected file',
        'stray.txt: unexpected file',
      ].join('\n')
    );
  });

  test('names a directory where a file is expected and a file where a directory is expected', () => {
    const root = layout({ 'mangostudio/inner': 'i', sidecar: 'not a directory' });

    expect(layoutError(root, ['mangostudio', 'sidecar/tool'])).toBe(
      [
        'Target archive layout mismatch:',
        'mangostudio: expected file, got directory',
        'mangostudio/inner: unexpected file',
        'sidecar: expected directory, got file',
        'sidecar/tool: missing file',
      ].join('\n')
    );
  });

  test('reports missing, extra and mismatched entries together', () => {
    const root = layout({ 'README.md': 'r', 'stray.txt': 's' });

    expect(layoutError(root, ['README.md', 'mangostudio'])).toBe(
      'Target archive layout mismatch:\nmangostudio: missing file\nstray.txt: unexpected file'
    );
  });

  test.skipIf(process.platform === 'win32')(
    'refuses symlinks, including one that points at an expected file, without following it',
    () => {
      const root = layout({ mangostudio: 'b', 'real/file': 'f' });
      symlinkSync('mangostudio', join(root, 'alias'));
      symlinkSync('real', join(root, 'real-link'));
      // A symlink to a directory must not make its children look like part of the tree.
      const outside = layout({ 'secret.txt': 's' });
      symlinkSync(outside, join(root, 'escape'));

      expect(layoutError(root, ['mangostudio', 'real/file', 'alias'])).toBe(
        [
          'Target archive layout mismatch:',
          'alias: symlink refused',
          'escape: symlink refused',
          'real-link: symlink refused',
        ].join('\n')
      );
    }
  );

  test.skipIf(process.platform === 'win32')('refuses a FIFO as a special file', async () => {
    const root = layout({ mangostudio: 'b' });
    await runOrThrow(['mkfifo', join(root, 'pipe')]);

    expect(layoutError(root, ['mangostudio'])).toBe(
      'Target archive layout mismatch:\npipe: special file refused'
    );
  });
});

describe('distribution extraction', () => {
  test('materializes tar.gz and zip archives into the same target layout', async () => {
    const rootDir = makeTempDir();
    const expectedMembers = ['README.md', 'mangostudio'];
    const sourceDir = join(rootDir, 'source');
    stageTarget(sourceDir, 'mangostudio');

    const tarArchive = join(rootDir, 'target.tar.gz');
    const zipArchive = join(rootDir, 'target.zip');
    const tar = tarCreationCommand(tarArchive, [{ directory: sourceDir, members: ['.'] }]);
    const zip = zipCreationCommand(zipArchive, sourceDir);
    await runOrThrow(tar.command, tar.cwd);
    await runOrThrow(zip.command, zip.cwd);

    const tarDestination = join(rootDir, '.mango', 'out', 'linux-x64');
    const zipDestination = join(rootDir, '.mango', 'out', 'windows-x64');
    await extractTargetArchive({
      archivePath: tarArchive,
      archiveFormat: 'tar.gz',
      destination: tarDestination,
      expectedMembers,
      rootDir,
    });
    await extractTargetArchive({
      archivePath: zipArchive,
      archiveFormat: 'zip',
      destination: zipDestination,
      expectedMembers,
      rootDir,
    });

    expect(fileSnapshot(tarDestination)).toEqual(fileSnapshot(sourceDir));
    expect(fileSnapshot(zipDestination)).toEqual(fileSnapshot(sourceDir));
  });

  // The whole release lane rests on this: a hub binary that arrives without its
  // executable bit is a broken install, and native extraction is what restores
  // the mode GNU tar used to. POSIX-only: Windows has no executable bit, and
  // Bun.Archive skips every symlink there regardless of privilege.
  test.skipIf(process.platform === 'win32')(
    'preserves the executable bit through native tar.gz extraction',
    async () => {
      const rootDir = makeTempDir();
      const sourceDir = join(rootDir, 'source');
      stageTarget(sourceDir, 'mangostudio');

      const archivePath = join(rootDir, 'target.tar.gz');
      const tar = tarCreationCommand(archivePath, [{ directory: sourceDir, members: ['.'] }]);
      await runOrThrow(tar.command, tar.cwd);

      const destination = join(rootDir, '.mango', 'out', 'linux-x64');
      await extractTargetArchive({
        archivePath,
        archiveFormat: 'tar.gz',
        destination,
        expectedMembers: ['README.md', 'mangostudio'],
        rootDir,
      });

      expect(statSync(join(destination, 'mangostudio')).mode & 0o111).not.toBe(0);
      expect(statSync(join(destination, 'README.md')).mode & 0o111).toBe(0);
    }
  );

  // The manifest records regular files only, so an archive carrying a symlink is
  // refused even when the member list names it, and nothing reaches the destination.
  test.skipIf(process.platform === 'win32')(
    'refuses a symlink in a tar.gz and leaves the destination untouched',
    async () => {
      const rootDir = makeTempDir();
      const sourceDir = join(rootDir, 'source');
      stageTarget(sourceDir, 'mangostudio');
      symlinkSync('mangostudio', join(sourceDir, 'mangostudio-link'));

      const archivePath = join(rootDir, 'target.tar.gz');
      const tar = tarCreationCommand(archivePath, [{ directory: sourceDir, members: ['.'] }]);
      await runOrThrow(tar.command, tar.cwd);

      const destination = join(rootDir, '.mango', 'out', 'linux-x64');
      await expect(
        extractTargetArchive({
          archivePath,
          archiveFormat: 'tar.gz',
          destination,
          expectedMembers: ['README.md', 'mangostudio', 'mangostudio-link'],
          rootDir,
        })
      ).rejects.toThrow('mangostudio-link: symlink refused');

      expect(existsSync(destination)).toBe(false);
    }
  );

  test('rejects unsafe tar.gz entries before writing to the output tree', async () => {
    const rootDir = makeTempDir();
    const archivePath = join(rootDir, 'target.tar.gz');
    await Bun.Archive.write(
      archivePath,
      { '../outside': 'escaped', mangostudio: 'binary' },
      { compress: 'gzip', level: 1 }
    );

    await expect(
      extractTargetArchive({
        archivePath,
        archiveFormat: 'tar.gz',
        destination: join(rootDir, '.mango', 'out', 'linux-x64'),
        expectedMembers: ['mangostudio'],
        rootDir,
      })
    ).rejects.toThrow(/Unsafe distribution archive entry/);

    expect(existsSync(join(rootDir, '.mango'))).toBe(false);
    expect(existsSync(join(rootDir, 'outside'))).toBe(false);
  });

  test('rejects unsafe zip entries before writing to the output tree', async () => {
    const rootDir = makeTempDir();
    const destination = join(rootDir, '.mango', 'out', 'windows-x64');
    let commandCount = 0;

    await expect(
      extractTargetArchive(
        {
          archivePath: join(rootDir, 'target.zip'),
          archiveFormat: 'zip',
          destination,
          expectedMembers: ['mangostudio.exe'],
          rootDir,
        },
        {
          unzipCommand: 'unzip',
          runCommand: () => {
            commandCount += 1;
            return Promise.resolve({ stdout: '../outside\n', stderr: '', exitCode: 0 });
          },
        }
      )
    ).rejects.toThrow(/Unsafe distribution archive entry/);

    expect(commandCount).toBe(1);
    expect(existsSync(join(rootDir, '.mango'))).toBe(false);
  });

  test('reports the archive path when a tar.gz cannot be read', async () => {
    const rootDir = makeTempDir();
    const archivePath = join(rootDir, 'target.tar.gz');
    writeFileSync(archivePath, 'not an archive');

    await expect(
      extractTargetArchive({
        archivePath,
        archiveFormat: 'tar.gz',
        destination: join(rootDir, '.mango', 'out', 'linux-x64'),
        expectedMembers: ['mangostudio'],
        rootDir,
      })
    ).rejects.toThrow(/Failed to read archive .*target\.tar\.gz/);
  });

  test('uses unzip when available and PowerShell when it is absent on Windows', () => {
    expect(
      zipArchiveCommands(
        'D:\\tmp\\target.zip',
        'D:\\a\\mangostudio',
        'C:\\tools\\unzip.exe',
        'win32'
      )
    ).toEqual({
      list: ['C:\\tools\\unzip.exe', '-Z1', 'D:/tmp/target.zip'],
      extract: ['C:\\tools\\unzip.exe', '-q', 'D:/tmp/target.zip', '-d', 'D:/a/mangostudio'],
    });

    const fallback = zipArchiveCommands(
      "D:\\tmp\\target's.zip",
      'D:\\a\\mangostudio',
      null,
      'win32'
    );
    expect(fallback.list.slice(0, 3)).toEqual(['powershell', '-NoProfile', '-Command']);
    expect(fallback.list[3]).toContain("target''s.zip");
    expect(fallback.extract.slice(0, 3)).toEqual(['powershell', '-NoProfile', '-Command']);
    expect(fallback.extract[3]).toContain('Expand-Archive');
  });
});
