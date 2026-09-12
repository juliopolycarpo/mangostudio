import { homedir } from 'node:os';
import type {
  ExternalAgentTargetId,
  ExternalIdentityIsolation,
} from '@mangostudio/shared/external-agents';
import { directoryHashDomainVersion } from '@mangostudio/shared/library';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';
import {
  profileForAllow,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
} from '@mangostudio/shared/runtime-home';
import { writeRuntimeDiagnostic } from './diagnostics';
import { HIDDEN_WINDOW } from './services/process-window';
import { isShellAvailable } from './services/shell';
import { supportsPty } from './services/terminal/pty';

/**
 * Bound on `git --version` / `gh --version`.
 *
 * These probes run inside {@link createLocalRuntimeManifest}, which is called
 * synchronously while an in-process session is opening. `Bun.spawnSync` blocks
 * the event loop, so a child that never exits also freezes the hub's 10s
 * in-process connect deadline (a timer) and, in tests, bun's 15s per-test
 * timeout. A `--version` that cannot answer in two seconds is not a git this
 * machine can use.
 *
 * The kill is not graceful: `timeout` on its own sends SIGTERM, and a child
 * that refuses it leaves `spawnSync` blocking for the child's whole life all
 * the same. A `--version` has nothing to flush.
 */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** What a `--version` probe answered, once it answered at all. */
type VersionProbeResult = { readonly available: true; readonly version?: string };

/**
 * Successful `--version` answers, keyed on the absolute path that produced
 * them.
 *
 * The expensive half of a probe is the child process, not the PATH walk, so
 * the child is the half memoised — and it is keyed on the resolved executable
 * rather than on the tool name, because {@link inspectGh} resolves against the
 * *live* PATH on purpose. Keying on the path keeps that invariant intact: a
 * PATH that now resolves to a different binary re-probes, and a repeat of the
 * same binary does not. `findShellExecutable` memoises the same class of
 * machine fact one layer over.
 *
 * Only successes are cached. A probe killed at {@link VERSION_PROBE_TIMEOUT_MS}
 * says nothing about the binary, and caching it would announce git as absent
 * for the whole life of the runtime over one transient hang — a worse bug than
 * the repeated spawn this cache exists to remove. A failure re-spawns on the
 * next call, still bounded by the same timeout.
 */
const versionProbeCache = new Map<string, VersionProbeResult>();

/**
 * Announces what this runtime may execute under the recorded consent.
 *
 * Effective features are the intersection of what the machine's owner granted
 * and what is actually present (git binary, shells). Advertising a capability
 * the binary cannot deliver is a worse bug than under-reporting.
 */
export function createLocalRuntimeManifest(
  allow: RuntimeCapabilityAllow = RUNTIME_CONSENT_PRESETS.full,
  externalAgents: {
    readonly targetIds?: readonly ExternalAgentTargetId[];
    readonly identityIsolation?: ExternalIdentityIsolation;
  } = {}
): RuntimeCapabilityManifest {
  const shells = (['bash', 'zsh', 'powershell'] as const).filter(isShellAvailable);
  // Both probes are spawns, and every field they feed is masked by `allow.git`
  // below — so on a machine whose owner refused git they measured a fact that
  // could not change the answer. That is two child processes per handshake and
  // two more per `runtime.health`, including under the `none` preset that
  // `collectRuntimeHealth` falls back to when the consent file cannot be read.
  const git: RuntimeCapabilityManifest['git'] = allow.git ? inspectGit() : { available: false };
  const gh: NonNullable<RuntimeCapabilityManifest['gh']> = allow.git
    ? inspectGh()
    : { available: false };
  const tools =
    allow.fsRead ||
    allow.fsWrite ||
    allow.shell ||
    allow.git ||
    allow.mcp ||
    allow.probing ||
    allow.library ||
    allow.checkpoints;

  return {
    platform: process.platform,
    arch: process.arch,
    pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
    homeDir: homedir(),
    shells: allow.shell ? shells : [],
    git: {
      available: allow.git && git.available,
      ...(allow.git && git.version ? { version: git.version } : {}),
    },
    // Gated on `git` because that is the weaker of the two capabilities `gh`
    // answers to — `gh.mutate` also needs `shell`, but a machine that granted
    // neither has no `gh` worth announcing. The version travels with it so a
    // later consumer can degrade one feature on an old CLI instead of hiding
    // the whole panel.
    gh: {
      available: allow.git && gh.available,
      ...(allow.git && gh.version ? { version: gh.version } : {}),
    },
    features: {
      tools,
      git: allow.git && git.available,
      probing: allow.probing,
      mcp: allow.mcp,
      library: allow.library,
      checkpoints: allow.checkpoints,
      fsRead: allow.fsRead,
      fsWrite: allow.fsWrite,
      shell: allow.shell,
      update: allow.update,
      externalAgents: allow.externalAgents === true,
      toolchain: true,
    },
    ...(externalAgents.targetIds && externalAgents.targetIds.length > 0
      ? { externalAgents: [...externalAgents.targetIds] }
      : {}),
    ...(externalAgents.identityIsolation
      ? { identityIsolation: externalAgents.identityIsolation }
      : {}),
    // Consent and ability together, like `git`: a machine whose owner refused
    // `shell`, or that has no shell to run, or a Bun without a PTY, all answer
    // false rather than advertising a panel that every open would refuse.
    terminal: allow.shell && shells.length > 0 && supportsPty(),
    profile: profileForAllow(allow),
    // Every filesystem method in this build re-checks its own targets against
    // the call's `pathPolicy` (see `services/fs.ts`). Stated rather than
    // inferred from the version, because the hub's alternative is to assume —
    // and assuming enforcement is the failure this field exists to prevent.
    enforcesPathPolicy: true,
    // This build publishes a Windows slot through a directory junction, so a
    // hub may offer it the same live upgrade it offers a POSIX peer. Stated
    // rather than inferred from the version: a peer can be older than the hub.
    publishesWindowsSlot: true,
    // Derived from the domain string this build actually hashes with, so a
    // later v3 cannot advertise v2 while computing v3. File hashes are
    // unversioned; only the directory domain moved.
    directoryHashDomain: directoryHashDomainVersion(),
    // Sent beside the intersection so a reader can tell the two apart: `git`
    // false in `features` with `allow.git` true is a machine without git, not
    // an owner who refused it.
    allow,
  };
}

/**
 * Probes the GitHub CLI the same way {@link inspectGit} probes Git, with one
 * difference that matters: `gh --version` prints two lines — the version and a
 * release URL — so only the first is parsed. A plain `.trim()`, which is all
 * Git's single-line output needs, would put a URL in the manifest and blow past
 * the health report's 64-character cap on the field.
 */
function inspectGh(): NonNullable<RuntimeCapabilityManifest['gh']> {
  // Resolved against the *live* PATH rather than the one this process started
  // with, because that is the PATH `buildGhEnvironment()` hands the spawn. The
  // two would otherwise be able to disagree — the manifest announcing a `gh`
  // the execution path cannot find, or hiding one it can — and a capability
  // announcement that does not describe the executable that will actually run
  // is worse than no announcement. `Bun.which` falls back to the startup PATH
  // when the option is undefined, so an unset PATH keeps the old behavior.
  const executable = Bun.which('gh', { PATH: process.env.PATH });
  if (!executable) return { available: false };

  return probeVersion(executable, parseGhVersion);
}

/**
 * Runs `<executable> --version` once per resolved executable path.
 *
 * Takes an already-resolved path rather than a tool name because the two
 * callers resolve differently on purpose — `git` against the PATH this process
 * started with, `gh` against the live one — while the spawn, its bound and the
 * caching are the same for both.
 *
 * @example probeVersion('/usr/bin/git', parseGitVersion) // => { available: true, version: '2.51.0' }
 */
function probeVersion(
  executable: string,
  parseVersion: (output: string) => string
): { available: boolean; version?: string } {
  const cached = versionProbeCache.get(executable);
  if (cached) return cached;

  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...HIDDEN_WINDOW,
  });
  if (!result.success) {
    // The manifest announces a machine with no `gh` and a machine whose `gh`
    // is merely too slow to answer identically, as `available: false`, so the
    // difference only survives if it is said here. The executable is named;
    // the PATH that found it is not — this channel is unredacted by design.
    //
    // `killed` is read from `exitedDueToTimeout`, not from `signalCode`: a
    // Windows `TerminateProcess` timeout carries no POSIX signal, so a probe
    // this bound actually killed would otherwise be misreported as a plain
    // non-zero exit.
    const signal = result.signalCode ?? null;
    writeRuntimeDiagnostic('version_probe_failed', {
      executable,
      killed: result.exitedDueToTimeout === true,
      ...(signal === null ? { exitCode: result.exitCode } : { signal }),
    });
    return { available: false };
  }

  const version = parseVersion(result.stdout.toString());
  const answer: VersionProbeResult = version ? { available: true, version } : { available: true };
  versionProbeCache.set(executable, answer);
  return answer;
}

/** `gh version 2.97.0 (2026-07-31)\nhttps://...` becomes `2.97.0`. */
export function parseGhVersion(output: string): string {
  const firstLine = output.split('\n', 1)[0]?.trim() ?? '';
  return firstLine
    .replace(/^gh version\s+/i, '')
    .replace(/\s*\(.*$/, '')
    .trim();
}

function inspectGit(): RuntimeCapabilityManifest['git'] {
  const executable = Bun.which('git');
  if (!executable) return { available: false };

  return probeVersion(executable, parseGitVersion);
}

/** `git version 2.51.0` becomes `2.51.0`; one line, unlike `gh`. */
function parseGitVersion(output: string): string {
  return output.trim().replace(/^git version\s+/i, '');
}
