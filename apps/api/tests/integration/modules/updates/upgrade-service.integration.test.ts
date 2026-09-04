/**
 * Runs the upgrade engine against the real embedded install.sh, so this is
 * the end-to-end proof that the argv and env this engine builds actually
 * carry out an upgrade — not just what the unit tests assert about the
 * plumbing that builds them.
 *
 * `$HOME` and the install root are temp directories for every case; nothing
 * here touches the real `~/.mango`. Windows has no POSIX shell to run
 * `install.sh` against, so the suite is skipped there — `install.ps1` is
 * covered by its own script-layout tests, not this engine-level one.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeStreamEvent } from '@mangostudio/shared/updates';
import { releaseAssetUrl } from '../../../../src/modules/environments/domain/wsl-runtime-release';
import {
  createUpgradeService,
  type UpgradeServiceDeps,
} from '../../../../src/modules/updates/application/upgrade-service';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';
import { resolveBuildPlatformId } from '../../../../src/modules/updates/domain/platform-id';
import {
  hubArchiveName,
  resolveUpgradeTarget,
} from '../../../../src/modules/updates/domain/resolve-target';
import { downloadVerified } from '../../../../src/modules/updates/infrastructure/release-download';
import { runScript } from '../../../../src/modules/updates/infrastructure/run-script';
import { FakeReleaseHost } from '../../../unit/modules/updates/support/fake-release-host';

const hasPosixShell = process.platform !== 'win32';
const PLATFORM_ID = resolveBuildPlatformId();

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An executable "mangostudio" that only ever answers --version, tarred alone at the archive root (no leading directory). */
async function buildVersionArchive(
  destinationDir: string,
  version: string
): Promise<{ assetName: string; bytes: Uint8Array }> {
  const workDir = await tempDir('mango-fixture-');
  await writeFile(join(workDir, 'mangostudio'), `#!/usr/bin/env bash\necho '${version}'\n`, {
    mode: 0o755,
  });
  const assetName = hubArchiveName(version, PLATFORM_ID);
  const archivePath = join(destinationDir, assetName);
  const tar = Bun.spawnSync(['tar', '-czf', archivePath, '-C', workDir, 'mangostudio']);
  if (tar.exitCode !== 0) {
    throw new Error(`tar failed building the ${version} fixture: ${tar.stderr.toString()}`);
  }
  return { assetName, bytes: await readFile(archivePath) };
}

/** A legacy self-managed root: `<root>/<version>/mangostudio`, and the bin link pointing straight at it (no `current`, no `install-origin.json`). */
async function seedLegacyInstall(home: string, version: string): Promise<{ distRoot: string }> {
  const distRoot = join(home, '.mango', 'dist');
  const versionDir = join(distRoot, version);
  await mkdir(versionDir, { recursive: true });
  const executable = join(versionDir, 'mangostudio');
  await writeFile(executable, `#!/usr/bin/env bash\necho '${version}'\n`, { mode: 0o755 });
  const binDir = join(home, '.local', 'bin');
  await mkdir(binDir, { recursive: true });
  await symlink(executable, join(binDir, 'mangostudio'));
  return { distRoot };
}

function probeFor(home: string, version: string, executableVersionDir: string): InstallOriginProbe {
  return {
    platform: process.platform,
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    execPath: join(home, '.mango', 'dist', executableVersionDir, 'mangostudio'),
    version,
    standalone: true,
    container: false,
    home,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Deps for one call: every network and process effect is real (the actual
 * `install.sh`, the actual filesystem), except the release host, which is a
 * fake serving exactly the fixture archives this file built.
 */
function makeDeps(
  home: string,
  version: string,
  executableVersionDir: string,
  host: FakeReleaseHost
): Partial<UpgradeServiceDeps> {
  const fetchDeps = { fetch: host.fetch, resolveHostname: host.resolveHostname };
  return {
    probe: () => probeFor(home, version, executableVersionDir),
    configuredChannel: () => 'stable',
    resolveUpgradeTarget: (request, context) => resolveUpgradeTarget(request, context, fetchDeps),
    downloadVerified: (resolved, destinationDir) =>
      downloadVerified(resolved, destinationDir, fetchDeps),
    readState: () => Promise.resolve(null),
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    platform: process.platform,
    platformId: PLATFORM_ID,
    getVersion: () => version,
    getBuildInfo: () => ({ gitSha: 'e2e0000', gitDirty: false, builtAt: '', buildType: 'test' }),
    pid: process.pid,
  };
}

function outputLines(events: readonly UpgradeStreamEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<UpgradeStreamEvent, { type: 'output' }> => event.type === 'output'
    )
    .map((event) => event.line);
}

async function stagingEntries(distRoot: string): Promise<string[]> {
  const entries = await readdir(distRoot).catch(() => []);
  return entries.filter((name) => name.startsWith('.staging-') || name.startsWith('.rollback-'));
}

describe.skipIf(!hasPosixShell)('upgrade-service against the real install.sh', () => {
  it('upgrades a legacy install, reports already-current on the next check, and rolls back', async () => {
    const home = await tempDir('mango-upgrade-e2e-home-');
    const { distRoot } = await seedLegacyInstall(home, '0.1.0');

    const releaseDir = await tempDir('mango-upgrade-e2e-release-');
    const { assetName, bytes } = await buildVersionArchive(releaseDir, '0.1.1');
    const checksum = sha256Hex(bytes);
    const host = new FakeReleaseHost({
      [releaseAssetUrl('0.1.1', assetName)]: { body: bytes },
      [releaseAssetUrl('0.1.1', 'SHA256SUMS')]: { body: `${checksum}  ${assetName}\n` },
    });

    // --- Upgrade 0.1.0 → 0.1.1, migrating the legacy layout in the process ---
    const events: UpgradeStreamEvent[] = [];
    const upgradeService = createUpgradeService(makeDeps(home, '0.1.0', '0.1.0', host));
    const report = await upgradeService.run(
      { channel: 'stable', version: '0.1.1', restart: true },
      (event) => events.push(event)
    );

    expect(report.outcome).toBe('upgraded');
    expect(report.exitCode).toBe(0);
    expect(report.restart).toBe('not-running');
    expect(outputLines(events).some((line) => line.includes('Installed MangoStudio 0.1.1'))).toBe(
      true
    );

    expect(await readlink(join(distRoot, 'current'))).toBe('0.1.1');
    expect(existsSync(join(distRoot, '0.1.0', 'mangostudio'))).toBe(true);
    expect(await stagingEntries(distRoot)).toEqual([]);

    const origin = JSON.parse(await readFile(join(distRoot, 'install-origin.json'), 'utf8'));
    expect(origin).toMatchObject({ origin: 'upgrade', version: '0.1.1', previousVersion: '0.1.0' });

    // --- Running the same upgrade again reports already-current, no download ---
    const secondService = createUpgradeService(makeDeps(home, '0.1.1', '0.1.1', host));
    const secondReport = await secondService.run(
      { channel: 'stable', version: '0.1.1', restart: true },
      () => undefined
    );
    expect(secondReport.outcome).toBe('already-current');

    // --- Rollback moves current back to the previous version ---
    const rollbackService = createUpgradeService(makeDeps(home, '0.1.1', '0.1.1', host));
    const rollbackReport = await rollbackService.rollback(() => undefined);

    expect(rollbackReport.outcome).toBe('upgraded');
    expect(rollbackReport.exitCode).toBe(0);
    expect(await readlink(join(distRoot, 'current'))).toBe('0.1.0');
    expect(await stagingEntries(distRoot)).toEqual([]);
  });

  it('reports failed with exit 2 and never runs the script when the checksum does not match', async () => {
    const home = await tempDir('mango-upgrade-e2e-home-');
    const { distRoot } = await seedLegacyInstall(home, '0.1.0');

    const releaseDir = await tempDir('mango-upgrade-e2e-release-');
    const { assetName, bytes } = await buildVersionArchive(releaseDir, '0.1.2');
    const wrongDigest = '0'.repeat(64);
    const host = new FakeReleaseHost({
      [releaseAssetUrl('0.1.2', assetName)]: { body: bytes },
      [releaseAssetUrl('0.1.2', 'SHA256SUMS')]: { body: `${wrongDigest}  ${assetName}\n` },
    });

    let scriptRan = false;
    const deps = makeDeps(home, '0.1.0', '0.1.0', host);
    const service = createUpgradeService({
      ...deps,
      runScript: (argv, options) => {
        scriptRan = true;
        return runScript(argv, options);
      },
    });

    const report = await service.run(
      { channel: 'stable', version: '0.1.2', restart: true },
      () => undefined
    );

    expect(report.outcome).toBe('failed');
    expect(report.exitCode).toBe(2);
    expect(report.message).toContain('checksum mismatch');
    expect(scriptRan).toBe(false);
    expect(await stagingEntries(distRoot)).toEqual([]);
    // The 0.1.0 install is untouched — nothing was ever extracted onto it.
    expect(existsSync(join(distRoot, '0.1.0', 'mangostudio'))).toBe(true);
    expect(existsSync(join(distRoot, 'current'))).toBe(false);
  });
});
