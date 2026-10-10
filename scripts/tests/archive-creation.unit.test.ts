import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTarArchive } from '../lib/archive';
import { tarCreationCommand, zipCreationCommand } from '../lib/archive-creation';
import { captureCommand } from '../lib/exec';
import { zipArchiveCommands } from '../lib/zip-archive';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stageSources(): { root: string; binaries: string; docs: string } {
  const root = mkdtempSync(join(tmpdir(), "mango-create-archive-'"));
  roots.push(root);
  const binaries = join(root, 'binary input');
  const docs = join(root, 'docs');
  mkdirSync(binaries);
  mkdirSync(docs);
  writeFileSync(join(binaries, 'mangostudio'), 'binary', { mode: 0o755 });
  writeFileSync(join(binaries, 'build-state.json'), 'exclude');
  writeFileSync(join(docs, 'README.md'), 'readme');
  return { root, binaries, docs };
}

describe('archive creation commands', () => {
  test('writes identical gzip bytes across a wall-clock second', async () => {
    const { root, binaries } = stageSources();
    const first = join(root, 'first.tar.gz');
    const second = join(root, 'second.tar.gz');
    for (const out of [first, second]) {
      const { command, cwd } = tarCreationCommand(out, [
        { directory: binaries, members: ['mangostudio'] },
      ]);
      const result = await captureCommand([...command], { cwd });
      expect(result.exitCode, result.stderr).toBe(0);
      if (out === first) await Bun.sleep(1_100);
    }
    expect(readFileSync(second)).toEqual(readFileSync(first));
  });
  test('keeps POSIX backslashes literal in source directories', async () => {
    const expected = '/tmp/release\\checkout';
    const injected = tarCreationCommand(
      '/tmp/fixture.tar',
      [{ directory: expected, members: ['.'] }],
      { platform: 'linux' }
    );
    expect(injected.command).toContain(expected);
    if (process.platform === 'win32') return;

    const { root } = stageSources();
    const literal = join(root, 'release\\checkout');
    const other = join(root, 'release', 'checkout');
    mkdirSync(literal);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(literal, 'mangostudio'), 'intended bytes');
    writeFileSync(join(other, 'mangostudio'), 'wrong bytes');
    const archivePath = join(root, 'literal.tar.gz');
    const { command, cwd } = tarCreationCommand(archivePath, [
      { directory: literal, members: ['mangostudio'] },
    ]);
    const result = await captureCommand([...command], { cwd });
    expect(result.exitCode, result.stderr).toBe(0);
    const archive = await openTarArchive(archivePath);
    const destination = join(root, 'literal-out');
    await archive.extract(destination);
    expect(readFileSync(join(destination, 'mangostudio'), 'utf8')).toBe('intended bytes');
  });
  test.each(['tar', 'tar.gz', 'tar.xz', 'tar.bz2'] as const)(
    'creates %s with multiple source roots and literal paths',
    async (format) => {
      const { root, binaries, docs } = stageSources();
      const archivePath = join(root, `bundle with spaces'.${format}`);
      const { command, cwd } = tarCreationCommand(
        archivePath,
        [
          { directory: binaries, members: ['.'] },
          { directory: docs, members: ['README.md'] },
        ],
        { format, exclude: ['build-state.json'] }
      );
      const result = await captureCommand([...command], { cwd });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      if (format === 'tar.xz' || format === 'tar.bz2') {
        // Bun's reader rejects these formats. Listing still proves the native
        // writer preserved the same members for unsupported-format fixtures.
        const listing = await captureCommand([command[0], '-tf', archivePath]);
        expect(listing.exitCode, listing.stderr).toBe(0);
        expect(listing.stdout).toContain('mangostudio');
        expect(listing.stdout).toContain('README.md');
        expect(listing.stdout).not.toContain('build-state.json');
        return;
      }
      const archive = await openTarArchive(archivePath);
      expect([...archive.entries].sort()).toEqual(['./mangostudio', 'README.md']);
      const destination = join(root, 'extracted');
      await archive.extract(destination);
      expect(readFileSync(join(destination, 'mangostudio'), 'utf8')).toBe('binary');
      expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('readme');
      if (process.platform !== 'win32')
        expect(statSync(join(destination, 'mangostudio')).mode & 0o111).not.toBe(0);
    }
  );

  test('creates a ZIP with literal paths, flat members and matching bytes', async () => {
    const { root, binaries } = stageSources();
    const archivePath = join(root, "bundle with spaces'.zip");
    const { command, cwd } = zipCreationCommand(archivePath, binaries);
    const result = await captureCommand([...command], { cwd });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const destination = join(root, 'extracted');
    // Read independently of the writer. The native PowerShell reader handles
    // literal Windows paths that MSYS unzip would parse as shell quotes.
    const commands = zipArchiveCommands(
      archivePath,
      destination,
      process.platform === 'win32' ? null : Bun.which('unzip')
    );
    const listing = await captureCommand([...commands.list]);
    expect(listing.exitCode, listing.stderr).toBe(0);
    expect(listing.stdout.trim().split(/\r?\n/).sort()).toEqual([
      'build-state.json',
      'mangostudio',
    ]);
    const extracted = await captureCommand([...commands.extract]);
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    expect(readFileSync(join(destination, 'mangostudio'), 'utf8')).toBe('binary');
    expect(readFileSync(join(destination, 'build-state.json'), 'utf8')).toBe('exclude');
  });

  test('keeps Windows drive prefixes out of tar output operands', () => {
    const result = tarCreationCommand(
      'D:\\assets\\bundle.tar.gz',
      [{ directory: 'C:\\build\\binary', members: ['mangostudio.exe'] }],
      { platform: 'win32', windowsDirectory: 'C:\\Windows' }
    );
    expect(result.cwd).toBe('D:\\assets');
    expect(result.command).toEqual([
      'C:\\Windows\\System32\\tar.exe',
      '-czf',
      'bundle.tar.gz',
      '--options',
      'gzip:!timestamp',
      '-C',
      'C:/build/binary',
      'mangostudio.exe',
    ]);
  });
});
