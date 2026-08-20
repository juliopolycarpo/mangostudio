import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
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

import { captureCommand } from '../lib/exec';
import { extractTargetArchive, zipArchiveCommands } from '../release/extract-target';

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

async function runOrThrow(command: string[], cwd?: string): Promise<void> {
  const result = await captureCommand(command, cwd ? { cwd } : undefined);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

describe('distribution extraction', () => {
  test('materializes tar.gz and zip archives into the same target layout', async () => {
    const rootDir = makeTempDir();
    const expectedMembers = ['README.md', 'mangostudio'];
    const sourceDir = join(rootDir, 'source');
    stageTarget(sourceDir, 'mangostudio');

    const tarArchive = join(rootDir, 'target.tar.gz');
    const zipArchive = join(rootDir, 'target.zip');
    await runOrThrow(['tar', '-czf', tarArchive, '-C', sourceDir, '.']);
    await runOrThrow(['zip', '-qr', zipArchive, '.'], sourceDir);

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
  // the mode GNU tar used to.
  test('preserves the executable bit and symlinks through native tar.gz extraction', async () => {
    const rootDir = makeTempDir();
    const sourceDir = join(rootDir, 'source');
    stageTarget(sourceDir, 'mangostudio');
    symlinkSync('mangostudio', join(sourceDir, 'mangostudio-link'));

    const archivePath = join(rootDir, 'target.tar.gz');
    await runOrThrow(['tar', '-czf', archivePath, '-C', sourceDir, '.']);

    const destination = join(rootDir, '.mango', 'out', 'linux-x64');
    await extractTargetArchive({
      archivePath,
      archiveFormat: 'tar.gz',
      destination,
      expectedMembers: ['README.md', 'mangostudio', 'mangostudio-link'],
      rootDir,
    });

    expect(statSync(join(destination, 'mangostudio')).mode & 0o111).not.toBe(0);
    expect(statSync(join(destination, 'README.md')).mode & 0o111).toBe(0);
    expect(lstatSync(join(destination, 'mangostudio-link')).isSymbolicLink()).toBe(true);
  });

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
