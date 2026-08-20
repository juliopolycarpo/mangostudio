import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractTarArchive, openTarArchive } from '../lib/archive';
import { captureCommand } from '../lib/exec';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-archive-'));
  tempDirs.push(dir);
  return dir;
}

async function stageGnuTarball(rootDir: string): Promise<string> {
  const sourceDir = join(rootDir, 'source');
  mkdirSync(join(sourceDir, 'nested'), { recursive: true });
  writeFileSync(join(sourceDir, 'mangostudio'), 'binary', { mode: 0o755 });
  writeFileSync(join(sourceDir, 'nested', 'README.md'), 'readme');

  const archivePath = join(rootDir, 'bundle.tar.gz');
  const result = await captureCommand(['tar', '-czf', archivePath, '-C', sourceDir, '.']);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return archivePath;
}

describe('native archive reading', () => {
  test('lists file entries and extracts the same instance', async () => {
    const rootDir = makeTempDir();
    const archivePath = await stageGnuTarball(rootDir);

    const archive = await openTarArchive(archivePath);
    expect([...archive.entries].sort()).toEqual(['./mangostudio', './nested/README.md']);

    const destination = join(rootDir, 'out');
    await archive.extract(destination);
    expect(readdirSync(destination).sort()).toEqual(['mangostudio', 'nested']);
  });

  test('extracts without a listing pass', async () => {
    const rootDir = makeTempDir();
    const archivePath = await stageGnuTarball(rootDir);

    const destination = join(rootDir, 'out');
    await extractTarArchive(archivePath, destination);
    expect(existsSync(join(destination, 'nested', 'README.md'))).toBe(true);
  });

  // The shape target distribution bundles ship in: stored, not gzipped, because
  // their one large member is an already-compressed platform archive.
  test('reads a stored tar and keeps the executable bit', async () => {
    const rootDir = makeTempDir();
    const sourceDir = join(rootDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary', { mode: 0o755 });

    // Named `.tar`, and detected from the bytes rather than from that name.
    const archivePath = join(rootDir, 'bundle.tar');
    const result = await captureCommand(['tar', '-cf', archivePath, '-C', sourceDir, '.']);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);

    const archive = await openTarArchive(archivePath);
    expect(archive.entries).toEqual(['./mangostudio']);

    const destination = join(rootDir, 'out');
    await archive.extract(destination);
    expect(statSync(join(destination, 'mangostudio')).mode & 0o111).toBeGreaterThan(0);
  });

  test('names the archive in read and extract failures', async () => {
    const rootDir = makeTempDir();
    const missing = join(rootDir, 'missing.tar.gz');
    await expect(openTarArchive(missing)).rejects.toThrow(/Failed to read archive .*missing/);

    const corrupt = join(rootDir, 'corrupt.tar.gz');
    writeFileSync(corrupt, 'not an archive');
    await expect(extractTarArchive(corrupt, join(rootDir, 'out'))).rejects.toThrow(
      /Failed to extract archive .*corrupt/
    );
  });

  // Documented so the constraint is discovered by a failing test rather than by
  // a release job: GNU tar auto-detects these, Bun.Archive does not read them.
  test('reads gzip only, and never zip', async () => {
    const rootDir = makeTempDir();
    const sourceDir = join(rootDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mangostudio'), 'binary');

    for (const [flag, name] of [
      ['-cJf', 'bundle.tar.xz'],
      ['-cjf', 'bundle.tar.bz2'],
    ] as const) {
      const archivePath = join(rootDir, name);
      const result = await captureCommand(['tar', flag, archivePath, '-C', sourceDir, '.']);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
      await expect(openTarArchive(archivePath)).rejects.toThrow(/Unrecognized archive format/);
    }

    const zipPath = join(rootDir, 'bundle.zip');
    const zipped = await captureCommand(['zip', '-qr', zipPath, '.'], { cwd: sourceDir });
    if (zipped.exitCode !== 0) throw new Error(zipped.stderr || zipped.stdout);
    await expect(openTarArchive(zipPath)).rejects.toThrow(/Unrecognized archive format/);
  });
});
