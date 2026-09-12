import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { directoryHashDomainVersion } from '@mangostudio/shared/library';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeManifest, parseGhVersion, parseGitVersion } from '../../src/manifest';
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

/**
 * Stages a `gh` that records every invocation, and reads the tally back.
 *
 * @example
 * const probe = await stageCountingGh('answers', 'echo "gh version 2.97.0"');
 */
async function stageCountingGh(
  name: string,
  body: string
): Promise<{ readonly restore: () => void; readonly invocations: () => Promise<number> }> {
  const log = join(probeDir, `${name}.log`);
  await writeFile(log, '');
  const restore = await stagePathWithGh(name, `#!/bin/sh\necho ran >> "${log}"\n${body}\n`);
  return {
    restore,
    invocations: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length,
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

  // Every test here stages its own directory, so each resolves to a distinct
  // absolute path and gets its own cache entry — no reset hook, and no
  // test-only export to reset one.
  it.skipIf(process.platform === 'win32')(
    'spawns the probe once per resolved binary, not once per manifest',
    async () => {
      // `gh` stands in for both probes: they share one helper, and `inspectGit`
      // resolves against the PATH this process started with, which no test can
      // stage from inside it.
      const probe = await stageCountingGh('answers-once', 'echo "gh version 2.97.0 (2026-07-31)"');

      try {
        const first = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
        const second = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        expect(first.gh).toEqual({ available: true, version: '2.97.0' });
        expect(second.gh).toEqual({ available: true, version: '2.97.0' });
        // A machine fact that cannot change during this process, measured once.
        expect(await probe.invocations()).toBe(1);
      } finally {
        probe.restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'spawns again when the live PATH resolves to a different binary',
    async () => {
      // A cache keyed on the tool name (or on a constant like `"gh"`) would
      // still pass the once-per-manifest test above without ever proving the
      // key is the resolved path. Staging a second `gh`, at a different
      // directory with a different reported version, is the case that only
      // passes if the cache really is keyed on that path.
      const first = await stageCountingGh('path-a', 'echo "gh version 1.0.0 (2026-01-01)"');
      try {
        const manifestA = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
        expect(manifestA.gh).toEqual({ available: true, version: '1.0.0' });
        expect(await first.invocations()).toBe(1);
      } finally {
        first.restore();
      }

      const second = await stageCountingGh('path-b', 'echo "gh version 2.0.0 (2026-02-02)"');
      try {
        const manifestB = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
        expect(manifestB.gh).toEqual({ available: true, version: '2.0.0' });
        expect(await second.invocations()).toBe(1);
      } finally {
        second.restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')('re-probes after a probe that was killed', async () => {
    // Remembering this answer would announce the CLI as absent for the whole
    // life of the runtime over one transient hang — worse than re-spawning,
    // which the two-second bound already pays for.
    const probe = await stageCountingGh('kill-not-remembered', 'sleep 30');

    try {
      expect(createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly).gh?.available).toBe(
        false
      );
      expect(createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly).gh?.available).toBe(
        false
      );

      expect(await probe.invocations()).toBe(2);
    } finally {
      probe.restore();
    }
  });

  it.skipIf(process.platform === 'win32')('announces a probe it had to kill', async () => {
    // `available: false` alone cannot tell a machine with no `gh` from one
    // whose `gh` is merely too slow to answer. The diagnostic is the only
    // place that difference survives, and stderr is where the hub collects it.
    const restore = await stagePathWithGh('announced-kill', '#!/bin/sh\nsleep 30\n');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

      const written = stderr.mock.calls.map(([line]) => String(line)).join('');
      expect(written).toContain('version_probe_failed');
      expect(written).toContain(join(probeDir, 'announced-kill', 'gh'));
      expect(written).toContain('"killed":true');
      // The channel is unredacted by design, so the PATH that found the binary
      // never travels on it — only the binary.
      const stagedPath = process.env.PATH;
      expect(stagedPath).toBeTruthy();
      expect(written).not.toContain(String(stagedPath));
    } finally {
      stderr.mockRestore();
      restore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reports a kill from exitedDueToTimeout, not merely from a signal',
    async () => {
      // Windows' `TerminateProcess` ends a timed-out probe without a POSIX
      // signal, so `signalCode` alone would misreport this as a plain
      // non-zero exit. `Bun.spawnSync` still marks the timeout with
      // `exitedDueToTimeout`, which is what `killed` must be read from.
      const restore = await stagePathWithGh('no-signal-timeout', '#!/bin/sh\n:\n');
      const spawnSync = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: null,
        signalCode: undefined,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        success: false,
        resourceUsage: {},
        exitedDueToTimeout: true,
        pid: 0,
      } as unknown as ReturnType<typeof Bun.spawnSync>);
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        const written = stderr.mock.calls.map(([line]) => String(line)).join('');
        expect(written).toContain('version_probe_failed');
        expect(written).toContain('"killed":true');
        expect(written).toContain('"exitCode":null');
      } finally {
        stderr.mockRestore();
        spawnSync.mockRestore();
        restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'runs no probe at all when the owner refused git',
    async () => {
      // Every field the two probes feed is already masked by `allow.git`, so a
      // machine that refused it was paying two child processes per manifest —
      // once per handshake and once per `runtime.health` — for constants.
      const probe = await stageCountingGh('no-git-consent', 'echo "gh version 3.0.0 (2026-03-03)"');

      try {
        const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.none);

        expect(manifest.git.available).toBe(false);
        expect(manifest.gh?.available).toBe(false);
        expect(await probe.invocations()).toBe(0);
      } finally {
        probe.restore();
      }
    }
  );

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

describe('parseGitVersion', () => {
  it('reads only the first line, so a wrapper cannot overflow the field', () => {
    expect(parseGitVersion('git version 2.51.0\n')).toBe('2.51.0');
    // A `git` on PATH is often a wrapper — a toolchain shim, a corporate
    // trampoline — and anything it prints after the version travels into the
    // manifest. The health report caps this field at 64 characters, so a second
    // line does not merely read wrong: it fails to encode. And the answer is
    // memoised, so one such probe would poison every later report.
    expect(
      parseGitVersion('git version 2.51.0\nwarning: templates not found in /usr/share/git-core')
    ).toBe('2.51.0');
    expect(parseGitVersion('')).toBe('');
  });
});
