/**
 * Stage-verify-publish a runtime binary into a slot.
 *
 * One known artifact, one known digest, one known path — not a general file
 * push. WSL and SSH both bind a {@link RuntimeCommandRunner} to this helper so
 * the audited install sequence lives in one place.
 *
 * Every script here is a constant (or a constant parameterized by a code-defined
 * slot). Values that vary — a version, bytes — travel as argv or stdin, never
 * spliced into the script string.
 */

import {
  mangoHomeDir,
  RUNTIME_BINARY_BASENAME,
  RUNTIME_CURRENT_LINK_NAME,
  type RuntimeSlot,
  runtimeSlotDir,
} from '@mangostudio/shared/runtime-home';

export interface RuntimeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Set when the command was killed rather than exiting, which a timeout does. */
  readonly signal?: string;
}

export interface RuntimeCommandOptions {
  readonly stdin?: Uint8Array;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly onStdinProgress?: (bytesWritten: number) => void;
}

/**
 * Runs a shell script on a target machine. The script is a constant; every
 * value that varies travels as an argv entry or on stdin.
 */
export type RuntimeCommandRunner = (
  script: string,
  options?: RuntimeCommandOptions
) => Promise<RuntimeCommandResult>;

/**
 * A path inside a slot, quoted for the target's own shell.
 *
 * `$HOME` is expanded there rather than here: the hub does not know where a
 * remote home directory is, and neither `wsl.exe --exec` nor a non-login ssh
 * command expands it. The layout comes from the shared runtime home, so the
 * directory an install writes into and the one a launcher reads from cannot
 * drift.
 */
export function runtimeSlotShellPath(slot: RuntimeSlot, ...segments: readonly string[]): string {
  return `"${[runtimeSlotDir(slot, { mangoHome: mangoHomeDir('$HOME') }), ...segments].join('/')}"`;
}

function installScript(slot: RuntimeSlot, stage: string): string {
  const versionDir = runtimeSlotShellPath(slot, '$1');
  const livePath = runtimeSlotShellPath(slot, '$1', RUNTIME_BINARY_BASENAME);
  const stagedPath = runtimeSlotShellPath(slot, '$1', `${RUNTIME_BINARY_BASENAME}.incoming`);
  const currentLink = runtimeSlotShellPath(slot, RUNTIME_CURRENT_LINK_NAME);
  const slotDir = runtimeSlotShellPath(slot);

  // Capture the previous `current` target before the swap so prune can keep it.
  // `$1` is the version being published; everything else under the slot that
  // looks like a version directory is dropped — current + previous only.
  // Skip symlinks (`current`) so we never follow them into the live version.
  // Compare with path prefixes so a version string that happens to contain `/`
  // still keeps the directories mkdir created for it.
  return (
    'set -e; ' +
    `prev=$(readlink ${currentLink} 2>/dev/null || true); ` +
    `mkdir -p ${versionDir}; ` +
    `${stage}; ` +
    `chmod +x ${stagedPath}; ` +
    `mv -f ${stagedPath} ${livePath}; ` +
    `ln -sfn "$1" ${currentLink}; ` +
    `keep=${slotDir}/"$1"; ` +
    `keep_prev=${slotDir}/"$prev"; ` +
    `for d in ${slotDir}/*; do ` +
    '[ -d "$d" ] || continue; ' +
    '[ -L "$d" ] && continue; ' +
    'case "$keep" in "$d"|"$d"/*) continue ;; esac; ' +
    'if [ -n "$prev" ]; then case "$keep_prev" in "$d"|"$d"/*) continue ;; esac; fi; ' +
    'rm -rf "$d"; ' +
    'done'
  );
}

/**
 * Stages a raw runtime binary from stdin into the slot, publishes it, and
 * prunes older version directories. `$1` is the version.
 */
export function runtimePushBinaryScript(slot: RuntimeSlot): string {
  const stagedPath = runtimeSlotShellPath(slot, '$1', `${RUNTIME_BINARY_BASENAME}.incoming`);
  return installScript(slot, `cat > ${stagedPath}`);
}

/**
 * Unpacks the runtime member out of a release platform archive on stdin.
 * Fallback for releases that only published archives. `$1` is the version.
 */
export function runtimePushArchiveScript(slot: RuntimeSlot): string {
  const stagedPath = runtimeSlotShellPath(slot, '$1', `${RUNTIME_BINARY_BASENAME}.incoming`);
  return installScript(slot, `tar -xzf - -O ${RUNTIME_BINARY_BASENAME} > ${stagedPath}`);
}

/** Reports the installed runtime's version via the slot's `current` link. */
export function runtimeVersionScript(slot: RuntimeSlot): string {
  const currentBinary = runtimeSlotShellPath(
    slot,
    RUNTIME_CURRENT_LINK_NAME,
    RUNTIME_BINARY_BASENAME
  );
  return `exec ${currentBinary} --version`;
}

/**
 * Removes version directories and the `current` link from a slot, leaving
 * `runtime.json` (and lock/credentials) so consent survives reinstall.
 */
export function runtimeRemoveSlotBytesScript(slot: RuntimeSlot): string {
  const slotDir = runtimeSlotShellPath(slot);
  return (
    'set -e; ' +
    `for d in ${slotDir}/*; do ` +
    '[ -e "$d" ] || continue; ' +
    'base=$(basename "$d"); ' +
    'case "$base" in runtime.json|runtime.lock|credentials.json) continue ;; esac; ' +
    'rm -rf "$d"; ' +
    'done'
  );
}

/**
 * Reports approximate byte size of version dirs in the slot (excludes config).
 *
 * GNU `du -sb` is preferred; the `-sk` fallback must run when `-b` fails.
 * Piping `du | awk` alone cannot fall through — awk exits 0 on empty stdin —
 * so each attempt captures `du`'s status in a command substitution first.
 */
export function runtimeSlotBytesScript(slot: RuntimeSlot): string {
  const slotDir = runtimeSlotShellPath(slot);
  return (
    `if out=$(du -sb ${slotDir} 2>/dev/null); then echo "$out" | awk '{print $1}'; ` +
    `elif out=$(du -sk ${slotDir} 2>/dev/null); then echo "$out" | awk '{print $1*1024}'; ` +
    `else echo 0; fi`
  );
}

export class RuntimePushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePushError';
  }
}

export interface PushRuntimeBinaryParams {
  readonly runner: RuntimeCommandRunner;
  readonly slot: RuntimeSlot;
  readonly version: string;
  readonly bytes: Uint8Array;
  /** When true, pipe as a platform archive and extract; otherwise cat the raw binary. */
  readonly fromArchive?: boolean;
  readonly timeoutMs?: number;
  readonly onStdinProgress?: (bytesWritten: number) => void;
}

/**
 * Push verified bytes into a slot, confirm `--version`, and prune older
 * version directories. The caller is responsible for digest verification against
 * the release manifest before calling this.
 */
export async function pushRuntimeBinary(params: PushRuntimeBinaryParams): Promise<void> {
  const script = params.fromArchive
    ? runtimePushArchiveScript(params.slot)
    : runtimePushBinaryScript(params.slot);

  const result = await params.runner(script, {
    stdin: params.bytes,
    args: [params.version],
    timeoutMs: params.timeoutMs,
    onStdinProgress: params.onStdinProgress,
  });
  if (result.exitCode !== 0) {
    throw new RuntimePushError(
      `Could not place the runtime in the ${params.slot} slot: ${describeResult(result)}`
    );
  }

  const check = await params.runner(runtimeVersionScript(params.slot), {
    timeoutMs: params.timeoutMs,
  });
  if (check.exitCode !== 0) {
    throw new RuntimePushError(
      `The runtime was placed in the ${params.slot} slot but does not run: ${describeResult(check)}`
    );
  }
  if (check.stdout.trim() !== params.version) {
    throw new RuntimePushError(
      `The runtime in the ${params.slot} slot reports version ${check.stdout.trim()} rather than ${params.version}.`
    );
  }
}

function describeResult(result: RuntimeCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (result.signal) {
    const cause = `it was stopped by ${result.signal}`;
    return detail ? `${detail} (${cause})` : cause;
  }
  return detail || `the command exited with code ${result.exitCode}`;
}
