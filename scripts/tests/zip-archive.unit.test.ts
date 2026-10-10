import { describe, expect, test } from 'bun:test';

import type { CaptureResult } from '../lib/exec';
import { extractZipArchive, openZipArchive, zipArchiveCommands } from '../lib/zip-archive';

class FakeArchiveCommands {
  readonly commands: string[][] = [];
  listing: CaptureResult = { stdout: 'tool.exe\r\nnested/readme.txt\r\n', stderr: '', exitCode: 0 };
  extraction: CaptureResult = { stdout: '', stderr: '', exitCode: 0 };

  run(command: string[]): Promise<CaptureResult> {
    this.commands.push(command);
    const listing = command.includes('-Z1') || (command[3] ?? '').includes('OpenRead');
    return Promise.resolve(listing ? this.listing : this.extraction);
  }
}

describe('ZIP archive reader', () => {
  test('lists CRLF entries with unzip before extracting to the requested Windows path', async () => {
    const commands = new FakeArchiveCommands();
    const archive = await openZipArchive('D:\\tools\\tool.zip', {
      platform: 'win32',
      unzipCommand: 'C:\\tools\\unzip.exe',
      runCommand: commands.run.bind(commands),
    });

    expect(archive.entries).toEqual(['tool.exe', 'nested/readme.txt']);
    expect(commands.commands).toEqual([['C:\\tools\\unzip.exe', '-Z1', 'D:/tools/tool.zip']]);

    await archive.extract('D:\\cache\\extracted');
    expect(commands.commands.at(-1)).toEqual([
      'C:\\tools\\unzip.exe',
      '-q',
      'D:/tools/tool.zip',
      '-d',
      'D:/cache/extracted',
    ]);
  });

  test('uses PowerShell when unzip is absent, with literal paths and unwrapped entry names', async () => {
    const commands = new FakeArchiveCommands();
    const archive = await openZipArchive("D:\\tools\\tool's.zip", {
      platform: 'win32',
      unzipCommand: null,
      runCommand: commands.run.bind(commands),
    });

    expect(archive.entries).toEqual(['tool.exe', 'nested/readme.txt']);
    expect(commands.commands).toHaveLength(1);
    const listing = commands.commands[0]?.[3];
    expect(listing).toContain("$ErrorActionPreference = 'Stop'");
    expect(listing).toContain("OpenRead('D:\\tools\\tool''s.zip')");
    expect(listing).toContain('[Console]::Out.WriteLine($_.FullName)');

    await archive.extract("D:\\cache\\tool's directory");
    const extraction = commands.commands.at(-1)?.[3];
    expect(extraction).toContain("$ErrorActionPreference = 'Stop'");
    expect(extraction).toContain("-LiteralPath 'D:\\tools\\tool''s.zip'");
    expect(extraction).toContain("-DestinationPath 'D:\\cache\\tool''s directory'");
  });

  test('extracts an already judged archive without listing it again', async () => {
    const commands = new FakeArchiveCommands();

    await extractZipArchive('/tmp/tool.zip', '/tmp/cache', {
      platform: 'linux',
      unzipCommand: '/usr/bin/unzip',
      runCommand: commands.run.bind(commands),
    });

    expect(commands.commands).toEqual([
      ['/usr/bin/unzip', '-q', '/tmp/tool.zip', '-d', '/tmp/cache'],
    ]);
  });

  test('names the archive when a direct extraction fails', async () => {
    const commands = new FakeArchiveCommands();
    commands.extraction = { stdout: '', stderr: 'disk full', exitCode: 1 };

    await expect(
      extractZipArchive('tools.zip', 'cache', {
        unzipCommand: 'unzip',
        runCommand: commands.run.bind(commands),
      })
    ).rejects.toThrow('Failed to extract ZIP archive tools.zip: disk full');
  });

  test('keeps POSIX unzip paths unchanged', () => {
    expect(zipArchiveCommands('/tmp/tool.zip', '/tmp/cache', '/usr/bin/unzip', 'linux')).toEqual({
      list: ['/usr/bin/unzip', '-Z1', '/tmp/tool.zip'],
      extract: ['/usr/bin/unzip', '-q', '/tmp/tool.zip', '-d', '/tmp/cache'],
    });
  });

  test('fails a partial listing with the archive path before extraction', async () => {
    const commands = new FakeArchiveCommands();
    commands.listing = { stdout: 'tool.exe\n', stderr: 'invalid ZIP', exitCode: 2 };

    await expect(
      openZipArchive('broken.zip', {
        unzipCommand: 'unzip',
        runCommand: commands.run.bind(commands),
      })
    ).rejects.toThrow('Failed to list ZIP archive broken.zip: invalid ZIP');
    expect(commands.commands).toHaveLength(1);
  });

  test('reports extraction failures even when the command returns no diagnostic', async () => {
    const commands = new FakeArchiveCommands();
    commands.extraction = { stdout: '', stderr: '', exitCode: 3 };
    const archive = await openZipArchive('tools.zip', {
      unzipCommand: 'unzip',
      runCommand: commands.run.bind(commands),
    });

    await expect(archive.extract('cache')).rejects.toThrow(
      'Failed to extract ZIP archive tools.zip: exit 3'
    );
  });
});
