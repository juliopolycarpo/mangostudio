import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { captureCommand } from '../lib/exec';
import { distributionTarArgs } from '../release/extract-distribution';
import { extractTargetArchive, targetArchiveCommands } from '../release/extract-target';

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
  mkdirSync(join(sourceDir, 'cursor-sidecar'), { recursive: true });
  writeFileSync(join(sourceDir, binary), 'binary');
  writeFileSync(join(sourceDir, 'README.md'), 'readme');
  writeFileSync(join(sourceDir, 'cursor-sidecar', 'run-agent.mjs'), 'sidecar');
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
  test('forces local forward-slash Windows paths and leaves POSIX tar arguments unchanged', () => {
    expect(distributionTarArgs('list', 'D:\\tmp\\bundle.tar.gz', undefined, 'win32')).toEqual([
      '--force-local',
      '-tzf',
      'D:/tmp/bundle.tar.gz',
    ]);
    expect(
      distributionTarArgs('extract', 'D:\\tmp\\bundle.tar.gz', 'D:\\a\\mangostudio', 'win32')
    ).toEqual(['--force-local', '-xzf', 'D:/tmp/bundle.tar.gz', '-C', 'D:/a/mangostudio']);
    expect(distributionTarArgs('extract', '/tmp/bundle.tar.gz', '/workspace', 'linux')).toEqual([
      '-xzf',
      '/tmp/bundle.tar.gz',
      '-C',
      '/workspace',
    ]);
  });

  test('materializes tar.gz and zip archives into the same target layout', async () => {
    const rootDir = makeTempDir();
    const expectedMembers = ['README.md', 'cursor-sidecar', 'mangostudio'];
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

  test('rejects unsafe target entries before writing to the output tree', async () => {
    const rootDir = makeTempDir();
    const destination = join(rootDir, '.mango', 'out', 'linux-x64');
    let commandCount = 0;

    await expect(
      extractTargetArchive(
        {
          archivePath: join(rootDir, 'target.tar.gz'),
          archiveFormat: 'tar.gz',
          destination,
          expectedMembers: ['mangostudio'],
          rootDir,
        },
        {
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

  test('uses unzip when available and PowerShell when it is absent on Windows', () => {
    expect(
      targetArchiveCommands(
        'D:\\tmp\\target.zip',
        'D:\\a\\mangostudio',
        'zip',
        'C:\\tools\\unzip.exe',
        'win32'
      )
    ).toEqual({
      list: ['C:\\tools\\unzip.exe', '-Z1', 'D:/tmp/target.zip'],
      extract: ['C:\\tools\\unzip.exe', '-q', 'D:/tmp/target.zip', '-d', 'D:/a/mangostudio'],
    });

    const fallback = targetArchiveCommands(
      "D:\\tmp\\target's.zip",
      'D:\\a\\mangostudio',
      'zip',
      null,
      'win32'
    );
    expect(fallback.list.slice(0, 3)).toEqual(['powershell', '-NoProfile', '-Command']);
    expect(fallback.list[3]).toContain("target''s.zip");
    expect(fallback.extract.slice(0, 3)).toEqual(['powershell', '-NoProfile', '-Command']);
    expect(fallback.extract[3]).toContain('Expand-Archive');
  });
});
