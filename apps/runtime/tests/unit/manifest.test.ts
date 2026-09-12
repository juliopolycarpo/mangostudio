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
 * A script that blocks must `exec` what it blocks on. The probe's bound sends
 * SIGKILL to the process it spawned — the `#!/bin/sh` wrapper — and a shell
 * cannot pass that on, so a plain `sleep` is orphaned holding the stdout pipe
 * it inherited and outlives the whole run. `exec` makes the sleeper itself the
 * process the bound kills.
 *
 * @example
 * const restore = await stagePathWithGh('hangs', '#!/bin/sh\nexec sleep 30\n');
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

type StderrSpy = { readonly mock: { readonly calls: readonly (readonly unknown[])[] } };

/** Every `version_probe_failed` line written for `executable`, in order. */
function announcementsFor(stderr: StderrSpy, executable: string): string[] {
  return stderr.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.includes('version_probe_failed') && line.includes(executable));
}

/**
 * The single announcement for `executable`; fails loudly when there is not one.
 *
 * @example announcementFor(stderr, '/tmp/probe/gh')
 */
function announcementFor(stderr: StderrSpy, executable: string): string {
  const lines = announcementsFor(stderr, executable);
  expect(lines).toHaveLength(1);
  return lines[0] ?? '';
}

/** The JSON detail `writeRuntimeDiagnostic` appended to a diagnostic line. */
function parseDiagnosticDetail(line: string): Record<string, unknown> {
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
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
    const restore = await stagePathWithGh('never-answers', '#!/bin/sh\nexec sleep 30\n');
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
  //
  // The `exec` does not cost the refusal this test is built on: a signal set to
  // *ignore* is inherited across `exec` (only a caught one resets to default),
  // so the sleeper itself still refuses SIGTERM — and is now the process the
  // bound's SIGKILL reaches, instead of leaking past the run.
  it.skipIf(process.platform === 'win32')('kills a probe that refuses to stop', async () => {
    const restore = await stagePathWithGh(
      'ignores-term',
      "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n"
    );
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
    const probe = await stageCountingGh('kill-not-remembered', 'exec sleep 30');

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
    const restore = await stagePathWithGh('announced-kill', '#!/bin/sh\nexec sleep 30\n');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

      const line = announcementFor(stderr, join(probeDir, 'announced-kill', 'gh'));
      expect(line).toContain('version_probe_failed');
      // The channel is unredacted by design, so the detail carries the binary
      // and nothing that could smuggle an environment with it. Asserted as the
      // exact key set rather than as the absence of one string: a whole-PATH
      // `not.toContain` can never fire, because no leak would reproduce the
      // PATH verbatim.
      const detail = parseDiagnosticDetail(line);
      expect(Object.keys(detail).sort()).toEqual(['executable', 'killed', 'signal']);
      expect(detail.killed).toBe(true);
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

        // Pinned to the staged `gh`: `inspectGit` runs first and consumes the
        // same mock whenever the real git is not yet memoised, so a bare
        // `toContain` would pass on git's announcement without `inspectGh`
        // ever having been exercised.
        const detail = parseDiagnosticDetail(
          announcementFor(stderr, join(probeDir, 'no-signal-timeout', 'gh'))
        );
        expect(detail.killed).toBe(true);
        expect(detail.exitCode).toBeNull();
      } finally {
        stderr.mockRestore();
        spawnSync.mockRestore();
        restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'announces a repeating failure once, not once per manifest',
    async () => {
      // The failure itself is deliberately not memoised, so the probe re-spawns
      // — but the hub keeps only a bounded tail of this peer's stderr, and a
      // line repeated on every `runtime.health` would evict the lines that tail
      // exists to carry.
      const executable = join(probeDir, 'repeat-failure', 'gh');
      const restore = await stagePathWithGh('repeat-failure', '#!/bin/sh\nexit 127\n');
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);
        createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        const detail = parseDiagnosticDetail(announcementFor(stderr, executable));
        expect(detail).toEqual({ executable, killed: false, exitCode: 127 });
      } finally {
        stderr.mockRestore();
        restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'announces the same binary again once its failure changes shape',
    async () => {
      // The dedup key is the failure, not the path — the case the sibling above
      // cannot distinguish, since a bare set of executables would satisfy it
      // too. A `gh` that exits 127 today and starts hanging tomorrow is a
      // different machine fact, and the hub only ever sees the fact that got
      // announced: collapsing the two would leave the tail carrying the exit
      // code long after the binary stopped answering at all.
      const executable = join(probeDir, 'changing-failure', 'gh');
      const restore = await stagePathWithGh('changing-failure', '#!/bin/sh\nexit 127\n');
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        // Rewritten in place rather than staged again: a second
        // `stagePathWithGh` would prepend a second directory and capture the
        // already-modified PATH as the one to restore.
        await writeFile(executable, '#!/bin/sh\nexec sleep 30\n');
        await chmod(executable, 0o755);
        createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        const details = announcementsFor(stderr, executable).map(parseDiagnosticDetail);
        expect(details).toHaveLength(2);
        expect(details[0]).toEqual({ executable, killed: false, exitCode: 127 });
        // The signal is asserted as a key rather than as `SIGKILL` for the same
        // reason the kill test above does: the value is the bound's business.
        expect(Object.keys(details[1] ?? {}).sort()).toEqual(['executable', 'killed', 'signal']);
        expect(details[1]?.killed).toBe(true);
      } finally {
        stderr.mockRestore();
        restore();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'announces a gh it cannot start instead of throwing out of the manifest',
    async () => {
      // `Bun.which` checks the executable bit, not the interpreter behind the
      // shebang, so this `gh` resolves cleanly and then makes `Bun.spawnSync`
      // *throw* ENOENT — as does a binary deleted between the two calls, and
      // EACCES for a directory. Uncaught, that throw escapes the handshake's
      // `manifest: () =>` arrow and `collectRuntimeHealth`, failing the whole
      // connection over one optional CLI.
      const executable = join(probeDir, 'broken-shebang', 'gh');
      const restore = await stagePathWithGh('broken-shebang', '#!/nonexistent/interp\necho hi\n');
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        const manifest = createLocalRuntimeManifest(RUNTIME_CONSENT_PRESETS.readonly);

        expect(manifest.gh?.available).toBe(false);
        const detail = parseDiagnosticDetail(announcementFor(stderr, executable));
        expect(detail).toEqual({ executable, killed: false, spawnError: 'ENOENT' });
      } finally {
        stderr.mockRestore();
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
