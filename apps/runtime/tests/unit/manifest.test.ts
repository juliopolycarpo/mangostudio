import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { directoryHashDomainVersion } from '@mangostudio/shared/library';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeManifest, parseGhVersion } from '../../src/manifest';
import { supportsPty } from '../../src/services/terminal/pty';

let probeDir = '';

beforeAll(async () => {
  probeDir = await mkdtemp(join(tmpdir(), 'mango-manifest-probe-'));
});

afterAll(async () => {
  if (probeDir) await rm(probeDir, { force: true, recursive: true });
});

/**
 * Puts a `gh` running `script` first on PATH; the returned call restores it.
 *
 * @example
 * const restore = await stagePathWithGh('hangs', '#!/bin/sh\nsleep 30\n');
 */
async function stagePathWithGh(name: string, script: string): Promise<() => void> {
  const dir = join(probeDir, name);
  await mkdir(dir, { recursive: true });
  const executable = join(dir, 'gh');
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = previous ? `${dir}${delimiter}${previous}` : dir;
  return () => {
    if (previous === undefined) {
      delete process.env.PATH;
      return;
    }
    process.env.PATH = previous;
  };
}

describe('createLocalRuntimeManifest', () => {
  it('derives a full profile from the full allow set', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.full);
    expect(manifest.profile).toBe('full');
    expect(manifest.features.fsRead).toBe(true);
    expect(manifest.features.fsWrite).toBe(true);
    expect(manifest.features.shell).toBe(true);
    expect(manifest.features.update).toBe(true);
    expect(manifest.features.tools).toBe(true);
    expect(manifest.features.toolchain).toBe(true);
    expect(manifest.enforcesPathPolicy).toBe(true);
    // The hub's win32 upgrade gate reads this and nothing else; a peer that
    // stays silent is treated as one that refuses Windows publication.
    expect(manifest.publishesWindowsSlot).toBe(true);
    expect(manifest.directoryHashDomain).toBe(directoryHashDomainVersion());
    // A shell binary is what CI actually has, so this is asserted as agreement
    // with `supportsPty()` rather than a hard-coded `true`.
    expect(manifest.terminal).toBe(manifest.shells.length > 0 && supportsPty());
  });

  it('advertises readonly without shell or write', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
    expect(manifest.profile).toBe('readonly');
    expect(manifest.features.fsRead).toBe(true);
    expect(manifest.features.fsWrite).toBe(false);
    expect(manifest.features.shell).toBe(false);
    expect(manifest.shells).toEqual([]);
    expect(manifest.features.mcp).toBe(false);
    expect(manifest.features.update).toBe(false);
    expect(manifest.features.probing).toBe(true);
    expect(manifest.features.library).toBe(true);
    // No shell consent means no PTY either, regardless of what this machine
    // could otherwise offer.
    expect(manifest.terminal).toBe(false);
  });

  it('announces gh under the same consent as git', () => {
    // `readonly` grants git, so whether `gh` is available is a fact about the
    // machine rather than about consent — asserted as a shape, because CI
    // agents do not all have the GitHub CLI installed.
    const readonly = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
    expect(readonly.gh).toBeDefined();
    expect(typeof readonly.gh?.available).toBe('boolean');
    expect(readonly.gh?.available).toBe(readonly.features.git && readonly.git.available);
  });

  // `inspectGh` resolves its binary against the live PATH, which is the seam a
  // hung probe can be staged through; `inspectGit` reads the startup PATH and
  // has none, so `gh` stands in for both — they share the bound.
  it.skipIf(process.platform === 'win32')('gives up on a probe that never answers', async () => {
    const restore = await stagePathWithGh('never-answers', '#!/bin/sh\nsleep 30\n');
    const started = Date.now();

    try {
      const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

      // The probe is `spawnSync`: unbounded, it blocks the event loop and with
      // it every timer on it, including the hub's 10s in-process connect
      // deadline. A probe that cannot answer is announced as absent instead.
      expect(manifest.gh?.available).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  });

  // SIGTERM is what `timeout` sends on its own, and a child is free to refuse
  // it: `spawnSync` then blocks for that child's whole life whatever the bound
  // says, which is the freeze the bound exists to prevent.
  it.skipIf(process.platform === 'win32')('kills a probe that refuses to stop', async () => {
    const restore = await stagePathWithGh('ignores-term', "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
    const started = Date.now();

    try {
      const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

      expect(manifest.gh?.available).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  });

  it('advertises none with every feature off', () => {
    const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.none);
    expect(manifest.profile).toBe('none');
    expect(manifest.features.tools).toBe(false);
    expect(manifest.features.fsRead).toBe(false);
    expect(manifest.features.fsWrite).toBe(false);
    expect(manifest.features.shell).toBe(false);
    expect(manifest.features.git).toBe(false);
    expect(manifest.features.probing).toBe(false);
    expect(manifest.features.mcp).toBe(false);
    expect(manifest.features.library).toBe(false);
    expect(manifest.features.checkpoints).toBe(false);
    expect(manifest.features.update).toBe(false);
    expect(manifest.git.available).toBe(false);
    expect(manifest.gh?.available).toBe(false);
    expect(manifest.gh?.version).toBeUndefined();
    expect(manifest.shells).toEqual([]);
  });
});

describe('parseGhVersion', () => {
  it('reads only the first line, which is where gh differs from git', () => {
    // Real output: a version line, then a release URL. A plain trim would put
    // that URL in the manifest and blow past the health report's length cap.
    expect(
      parseGhVersion(
        'gh version 2.97.0 (2026-07-31)\nhttps://github.com/cli/cli/releases/tag/v2.97.0\n'
      )
    ).toBe('2.97.0');
    expect(parseGhVersion('gh version 2.40.1')).toBe('2.40.1');
    expect(parseGhVersion('')).toBe('');
  });
});
