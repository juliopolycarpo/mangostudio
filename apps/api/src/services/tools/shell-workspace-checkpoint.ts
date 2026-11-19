/**
 * Workspace checkpoints for a shell command: the answer to "what did it write?"
 * when the hub cannot know before the command runs.
 *
 * The builtin mutators hand the runtime one path, get its before-state back and
 * persist a manifest row under that path's lock. A shell command writes through
 * a child process, so there is no path list to snapshot first. This module
 * snapshots a bounded set instead — the regular files git tracks or would
 * track under the chat workdir — runs the command, hashes that set again, and
 * persists a row for each file whose bytes differ.
 *
 * What "covered" means, and the only thing it means: every regular file git
 * lists under the workdir that the snapshot held, plus every file the command
 * created there, is restored by a revert. It does not cover files git ignores,
 * paths outside the workdir, symlinks, submodules, or git's own state (index,
 * refs, HEAD): a command that commits leaves the commit behind.
 *
 * Whenever coverage is not provable the call degrades to the existing
 * disclosure — the `shell` source is noted — instead of claiming a revert it
 * cannot deliver. A partly covered call records the rows it has and still notes
 * the source, so revert says what it did not undo.
 *
 * Deleting a file is what reverting a create does, so a create is recorded only
 * when it is provably new and provably the command's: the path was not in the
 * listing taken before the command (whether or not its bytes could be read),
 * does not match one in case on a case-folding filesystem, was not ignored
 * before, and was modified inside the command's window. Anything else leaves
 * the file alone and marks the call partial. What no file system call can tell
 * apart is the command's own write from a concurrent writer's during the run;
 * that stays a stated limit of the setting.
 *
 * Cost scales with the tree, not with what the command touched, which is why
 * this is opt-in and capped. On a 4.8k-file, 57 MB checkout a full capture took
 * about 10 s and moved 65 MB of base64 through the runtime pipe. Each path is
 * therefore statted first, which moves no content, and anything over the limits
 * below degrades before a byte of file data is loaded. Every phase runs under a
 * time budget enforced on its runtime calls.
 */

import {
  RUNTIME_ABSENT_HASH,
  type RuntimeBeforeSnapshot,
  type RuntimeMutationSnapshot,
} from '@mangostudio/shared/runtime-contract';
import { mapWithConcurrency } from '@mangostudio/shared/utils/concurrency';

import { createDiagnosticLogger } from '../../lib/logger';
import { noteUncheckpointedSource } from '../../modules/file-checkpoints/application/note-uncheckpointed-source';
import type { RuntimeClient } from '../runtime-client/runtime-client';
import type { TargetPaths } from '../runtime-client/target-paths';
import { withMutationPersistence } from './file-mutation-snapshot';
import type { ToolContext } from './types';

const logger = createDiagnosticLogger('file-checkpoints');

/** Past any of these the call degrades to the disclosure instead of snapshotting. */
export const SHELL_WORKSPACE_LIMITS = {
  /** Files in the snapshot set, and separately the files a command may add to it. */
  maxFiles: 500,
  /** Base64-decoded bytes held for the whole snapshot. */
  maxBytes: 16 * 1024 * 1024,
  /** Wall-clock budget for building the snapshot, git listing included. */
  setupBudgetMs: 5_000,
} as const;

export type ShellWorkspaceLimits = { -readonly [K in keyof typeof SHELL_WORKSPACE_LIMITS]: number };

const CAPTURE_CONCURRENCY = 8;
const HASH_CONCURRENCY = 16;
const GIT_TIMEOUT_MS = 20_000;
/** A runtime that refuses this many captures is refusing the capability, not one file. */
const MAX_CAPTURE_FAILURES = 5;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

export type WorkspaceUnavailableReason =
  | 'no_workdir'
  | 'cwd_outside_workdir'
  | 'git_unavailable'
  | 'too_many_files'
  | 'too_many_bytes'
  | 'too_slow'
  | 'capture_refused'
  | 'stat_unsupported';

/** A file as it stood before the command. `hash: null` means it was absent. */
export interface BaselineFile {
  readonly hash: string | null;
  /** Absent when the bytes could not be captured; the file is then hash-only. */
  readonly contentBase64?: string;
}

export interface WorkspaceListing {
  /** Paths relative to the workdir, `/`-separated, deduplicated, in listing order. */
  readonly files: readonly string[];
}

export interface WorkspaceChange {
  readonly path: string;
  readonly op: 'create' | 'edit' | 'delete';
  readonly before: BaselineFile;
  readonly afterHash: string | null;
}

/**
 * Splits `git ls-files -z -s -o --exclude-standard` into the regular files it
 * names. A tracked record reads `<mode> <object> <stage>\t<path>` (a conflicted
 * path appears once per stage); an untracked one is the bare path, and a
 * trailing `/` marks a nested repository, which is not ours to snapshot.
 *
 * Symlinks (mode 120000) and gitlinks (160000) are skipped: capture follows a
 * link, so a restore through one would write bytes over the link's target.
 */
export function parseWorkspaceListing(stdout: string): string[] {
  const files = new Set<string>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tracked = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(record);
    const path = tracked ? tracked[2] : record;
    if (!path || path.endsWith('/') || !isUsablePath(path)) continue;
    if (tracked && !REGULAR_FILE_MODES.has(tracked[1] ?? '')) continue;
    files.add(path);
  }
  return [...files];
}

/** Git decodes a name it cannot represent as UTF-8 lossily; that path cannot be addressed back. */
function isUsablePath(path: string): boolean {
  return !path.includes('�');
}

/**
 * True when `path` is, or sits under, something git ignored before the command.
 * Such a path may have existed all along — a command that un-ignores it or
 * force-adds it makes it appear in the listing without having created it, and a
 * revert that removed it would destroy a file the command never wrote.
 */
export function isHiddenBeforeCommand(path: string, ignoredEntries: ReadonlySet<string>): boolean {
  if (ignoredEntries.has(path)) return true;
  for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
    if (ignoredEntries.has(path.slice(0, end + 1))) return true;
  }
  return false;
}

/**
 * Decides which paths the command changed. `current` maps a path to its hash
 * now (`null` for absent); a path missing from it could not be read and is left
 * out, which the caller reports as partial coverage.
 */
export function planWorkspaceChanges(
  baseline: ReadonlyMap<string, BaselineFile>,
  current: ReadonlyMap<string, string | null>
): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [path, afterHash] of current) {
    const before = baseline.get(path) ?? { hash: null };
    if (before.hash === afterHash) continue;
    changes.push({
      path,
      op: before.hash === null ? 'create' : afterHash === null ? 'delete' : 'edit',
      before,
      afterHash,
    });
  }
  return changes;
}

/** Wall-clock span of the command on the hub's clock. */
export interface CommandWindow {
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Slack on each side of the window: coarse filesystem timestamps (FAT keeps two
 * seconds) and a runtime whose clock is not the hub's. It fails safe — a clock
 * further off than this makes a create read as not the command's, which leaves a
 * file behind and says so, where the other direction would delete one.
 */
export const COMMAND_WINDOW_SLACK_MS = 2_000;

/**
 * Whether a file's modification time places its write inside the command's run.
 *
 * This keeps out what the snapshot window lets in: a file written by someone
 * else while the baseline was being taken, or while the post-run listing was.
 * It cannot tell the command's write from another process's during the command
 * itself, and no file system call can; that remains a stated limit. An unknown
 * time (a platform that has none) is not evidence of anything.
 */
export function wasWrittenDuringCommand(
  modifiedAtMs: number | undefined,
  window: CommandWindow
): boolean {
  if (modifiedAtMs === undefined || !Number.isFinite(modifiedAtMs)) return false;
  return (
    modifiedAtMs >= window.startedAt - COMMAND_WINDOW_SLACK_MS &&
    modifiedAtMs <= window.endedAt + COMMAND_WINDOW_SLACK_MS
  );
}

/**
 * The key under which two spellings of a path collide on a case-insensitive
 * filesystem. NFC first, because macOS stores names decomposed.
 */
export function foldPathKey(relative: string): string {
  return relative.normalize('NFC').toLowerCase();
}

/**
 * Splits the post-command listing into the paths that are new to the command
 * and the ones that only look new.
 *
 * A path the listing named before the command is never new, whether or not the
 * snapshot managed to read it: a file it could not capture or hash is still a
 * file that existed, and recording it as a create would let a revert delete it.
 *
 * With `foldedBefore` set (a case-insensitive filesystem), a path that matches a
 * pre-command one only in case is a rename of it — `git mv Foo.ts foo.ts` — and
 * both spellings name the same file there, so treating it as a create would
 * delete the only copy. Those come back in `renamedByCase`, never in `added`.
 */
export function selectAddedPaths(
  listedAfter: readonly string[],
  listedBefore: ReadonlySet<string>,
  foldedBefore: ReadonlySet<string> | null
): { added: string[]; renamedByCase: string[] } {
  const added: string[] = [];
  const renamedByCase: string[] = [];
  for (const path of listedAfter) {
    if (listedBefore.has(path)) continue;
    if (foldedBefore?.has(foldPathKey(path))) renamedByCase.push(path);
    else added.push(path);
  }
  return { added, renamedByCase };
}

type Baseline =
  | {
      readonly ok: true;
      readonly files: Map<string, BaselineFile>;
      /** Every path the pre-command listing named, captured or not. */
      readonly listedBefore: ReadonlySet<string>;
      /** Folded keys of `listedBefore`, or null when the filesystem is case-sensitive. */
      readonly foldedBefore: ReadonlySet<string> | null;
      readonly ignoredEntries: ReadonlySet<string>;
      /** Files whose pre-command state is known only by hash, so they cannot be restored. */
      readonly hashOnly: Set<string>;
      /** True when some regular file could not be snapshotted or hashed at all. */
      readonly incomplete: boolean;
    }
  | { readonly ok: false; readonly reason: WorkspaceUnavailableReason };

export interface ShellWorkspaceCheckpointInput<T> {
  readonly context: ToolContext;
  readonly runtime: RuntimeClient;
  readonly paths: TargetPaths;
  /** Directory the command runs in, already resolved. */
  readonly cwd: string | undefined;
  readonly run: () => Promise<T>;
  readonly limits?: ShellWorkspaceLimits;
}

/**
 * Runs `run` with the workspace snapshotted around it, then notes the `shell`
 * source unless the snapshot covered the call. Never fails the command because
 * of its own bookkeeping: a snapshot that cannot be taken degrades, one that
 * cannot be persisted afterwards is reported partial.
 *
 * // Usage: await runWithWorkspaceCheckpoint({ context, runtime, paths, cwd, run })
 */
export async function runWithWorkspaceCheckpoint<T>(
  input: ShellWorkspaceCheckpointInput<T>
): Promise<T> {
  const { context, run } = input;
  const limits = input.limits ?? { ...SHELL_WORKSPACE_LIMITS };
  const resolved = resolveWorkspaceRoot(input);
  const baseline: Baseline = resolved.ok
    ? await captureBaseline(input.runtime, input.paths, resolved.root, limits, context.signal)
    : resolved;

  if (!baseline.ok || !resolved.ok) {
    logger.info('shell_workspace_checkpoint_unavailable', {
      chatId: context.chatId,
      reason: baseline.ok ? 'no_workdir' : baseline.reason,
    });
    await noteUncheckpointedSource(context, 'shell');
    return await run();
  }
  const root = resolved.root;

  let fullyCovered = false;
  // The window starts after the snapshot, not before: a file another process
  // wrote while the baseline was being taken is in neither listing's "before"
  // and must not read as the command's.
  const window = { startedAt: Date.now(), endedAt: Date.now() };
  try {
    return await run();
  } finally {
    window.endedAt = Date.now();
    // Whatever ended the command, it may already have written: a failure, a
    // timeout or an abort is exactly when the files are half-changed.
    try {
      fullyCovered = await recordWorkspaceChanges(input, root, baseline, limits, window);
    } catch (error) {
      logger.warn('shell_workspace_checkpoint_not_recorded', {
        chatId: context.chatId,
        messageId: context.assistantMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!fullyCovered) await noteUncheckpointedSource(context, 'shell');
  }
}

function resolveWorkspaceRoot(
  input: ShellWorkspaceCheckpointInput<unknown>
): { ok: true; root: string } | { ok: false; reason: WorkspaceUnavailableReason } {
  const { context, paths, cwd } = input;
  const configured = context.workdirPolicy?.root ?? context.workdir;
  if (!configured || !paths.isAbsolute(configured)) return { ok: false, reason: 'no_workdir' };
  const root = paths.canonical(configured);
  // A command running elsewhere writes elsewhere; the snapshot would describe
  // a tree it does not touch and claim coverage of nothing.
  if (cwd && !paths.contains(root, paths.canonical(cwd))) {
    return { ok: false, reason: 'cwd_outside_workdir' };
  }
  return { ok: true, root };
}

async function captureBaseline(
  runtime: RuntimeClient,
  paths: TargetPaths,
  root: string,
  limits: ShellWorkspaceLimits,
  signal: AbortSignal | undefined
): Promise<Baseline> {
  const deadline = new Deadline(limits.setupBudgetMs, signal);

  const [listing, ignoredEntries, foldsCase] = await Promise.all([
    listWorkspace(runtime, root, deadline),
    listIgnoredEntries(runtime, root, deadline),
    filesystemFoldsCase(runtime, root, deadline),
  ]);
  if (!listing || !ignoredEntries) {
    return { ok: false, reason: deadline.expired ? 'too_slow' : 'git_unavailable' };
  }
  if (listing.files.length > limits.maxFiles) return { ok: false, reason: 'too_many_files' };

  const files = new Map<string, BaselineFile>();
  const hashOnly = new Set<string>();
  let incomplete = false;
  let failures = 0;
  let abort: WorkspaceUnavailableReason | undefined;

  // First pass: stat every listed path. It moves no content, so the caps below
  // are decided before a single byte of file data crosses the pipe.
  const present = new Map<string, ObservedFile>();
  await mapWithConcurrency(listing.files, CAPTURE_CONCURRENCY, async (relative) => {
    if (abort) return;
    if (deadline.expired) {
      abort = 'too_slow';
      return;
    }
    const path = paths.join(root, relative);
    const observed = await statFile(runtime, path, deadline);
    if (!observed) {
      if (deadline.expired) {
        abort = 'too_slow';
        return;
      }
      // Only a runtime refusing the capability, not one file, fails this many.
      incomplete = true;
      failures += 1;
      if (failures > MAX_CAPTURE_FAILURES) abort = 'capture_refused';
      return;
    }
    // A runtime that predates the stat fields cannot say what a path is, and
    // the one thing that matters here is that it is not a link.
    if (observed.hash !== null && observed.size === undefined) {
      abort = 'stat_unsupported';
      return;
    }
    // A link is not ours to restore: capture follows it, so a revert would write
    // bytes over whatever it points at. The listing still names it, which keeps
    // a later create from claiming the path.
    if (observed.symlink) return;
    if (observed.hash === null) files.set(path, { hash: null });
    else present.set(path, observed);
  });
  if (abort) return { ok: false, reason: abort };

  let plannedBytes = 0;
  for (const observed of present.values()) plannedBytes += observed.size ?? 0;
  if (plannedBytes > limits.maxBytes) return { ok: false, reason: 'too_many_bytes' };

  let capturedBytes = 0;
  await mapWithConcurrency([...present], CAPTURE_CONCURRENCY, async ([path, observed]) => {
    if (abort) return;
    if (deadline.expired) {
      abort = 'too_slow';
      return;
    }
    let snapshot: RuntimeBeforeSnapshot;
    try {
      snapshot = await runtime.snapshot.capture({ path }, { signal: deadline.signal });
    } catch (error) {
      if (deadline.callerAborted) throw error;
      if (deadline.expired) {
        abort = 'too_slow';
        return;
      }
      // Typically the runtime's per-file size refusal. The hash from the first
      // pass still says whether the file changed, which is worth having when it
      // did not.
      files.set(path, { hash: observed.hash });
      hashOnly.add(path);
      return;
    }
    if (!snapshot.exists) {
      files.set(path, { hash: null });
      return;
    }
    // The sizes above were a moment ago; a file that grew since still may not
    // push the snapshot past its cap.
    capturedBytes += Buffer.byteLength(snapshot.contentBase64 ?? '', 'base64');
    if (capturedBytes > limits.maxBytes) {
      abort = 'too_many_bytes';
      return;
    }
    if (typeof snapshot.contentBase64 !== 'string' || typeof snapshot.hash !== 'string') {
      incomplete = true;
      return;
    }
    files.set(path, { hash: snapshot.hash, contentBase64: snapshot.contentBase64 });
  });

  if (abort) return { ok: false, reason: abort };
  return {
    ok: true,
    files,
    listedBefore: new Set(listing.files),
    foldedBefore: foldsCase ? new Set(listing.files.map(foldPathKey)) : null,
    ignoredEntries,
    hashOnly,
    incomplete,
  };
}

/**
 * Whether the workdir's filesystem treats `Foo.ts` and `foo.ts` as one file.
 * Git probes the volume at `init` and records the answer as `core.ignorecase`,
 * which is the one fact that is right for the runtime's disk rather than the
 * hub's. The platform is the fallback for a repository whose config lost it.
 */
async function filesystemFoldsCase(
  runtime: RuntimeClient,
  root: string,
  deadline: Deadline
): Promise<boolean> {
  if (runtime.manifest.platform === 'darwin' || runtime.manifest.platform === 'win32') return true;
  try {
    const result = await runtime.git.exec(
      {
        args: ['config', '--type=bool', '--get', 'core.ignorecase'],
        cwd: root,
        timeoutMs: Math.min(GIT_TIMEOUT_MS, deadline.remainingMs),
        // Exit 1 is git's "key not set", an answer rather than a failure.
        acceptedExitCodes: [0, 1],
      },
      { signal: deadline.signal }
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  } catch (error) {
    if (deadline.callerAborted) throw error;
    return false;
  }
}

/**
 * Records the rows for what the command changed. Returns true only when every
 * change it found has a row and nothing was left unexamined.
 */
async function recordWorkspaceChanges(
  input: ShellWorkspaceCheckpointInput<unknown>,
  root: string,
  baseline: Extract<Baseline, { ok: true }>,
  limits: ShellWorkspaceLimits,
  window: CommandWindow
): Promise<boolean> {
  const { runtime, paths, context } = input;
  let complete = !baseline.incomplete;

  // The turn's own abort is deliberately not part of this: a command that was
  // cancelled is exactly when files are half-written and the rows matter. What
  // bounds the diff is a budget of its own, so a stalled runtime or a huge tree
  // cannot hold the tool result back indefinitely.
  const deadline = new Deadline(limits.setupBudgetMs);
  const listing = await listWorkspace(runtime, root, deadline);
  if (!listing) return false;
  const { added: addedRelative, renamedByCase } = selectAddedPaths(
    listing.files,
    baseline.listedBefore,
    baseline.foldedBefore
  );
  // A case-only rename is not recorded (see `selectAddedPaths`), so the call is
  // not fully covered however the rest turns out.
  if (renamedByCase.length > 0) complete = false;
  let added = addedRelative.map((relative) => paths.join(root, relative));
  if (added.length > limits.maxFiles) {
    // A command that dumps this many new files is a build, not an edit: keep a
    // bounded prefix and say the rest is uncovered.
    added = added.slice(0, limits.maxFiles);
    complete = false;
  }

  const candidates = [...baseline.files.keys(), ...added];
  const observedFiles = await mapWithConcurrency(candidates, HASH_CONCURRENCY, async (path) => ({
    path,
    // Past the budget nothing more is asked; the path is reported unexamined.
    observed: deadline.expired ? undefined : await statFile(runtime, path, deadline),
  }));
  const current = new Map<string, string | null>();
  const modifiedAt = new Map<string, number | undefined>();
  for (const { path, observed } of observedFiles) {
    if (!observed) {
      complete = false;
    } else if (observed.symlink) {
      // A regular file the command replaced with a link cannot be restored in
      // place; one it newly created is outside what is covered, like any link.
      if (baseline.files.get(path)?.hash != null) complete = false;
    } else {
      current.set(path, observed.hash);
      modifiedAt.set(path, observed.modifiedAtMs);
    }
  }

  const planned = planWorkspaceChanges(baseline.files, current);
  // Bytes the command moved away from a path. A move keeps its modification
  // time, so a created path holding exactly these bytes is the command's even
  // though its timestamp predates the window.
  const vanishedHashes = new Set(
    planned.flatMap((change) => (change.op === 'create' ? [] : [change.before.hash]))
  );
  const changes = planned.filter((change) => {
    if (change.op === 'create') {
      if (isHiddenBeforeCommand(relativeTo(paths, root, change.path), baseline.ignoredEntries)) {
        complete = false;
        return false;
      }
      // Deleting a created file is the revert, so a create must be the command's.
      // Another process's file, written outside the window, is not.
      if (
        !wasWrittenDuringCommand(modifiedAt.get(change.path), window) &&
        !vanishedHashes.has(change.afterHash)
      ) {
        complete = false;
        return false;
      }
    }
    if (baseline.hashOnly.has(change.path)) {
      complete = false;
      return false;
    }
    return true;
  });
  if (changes.length === 0) return complete;

  // A fresh budget for persistence: the rows found above are the point of the
  // diff, and a spent one would discard all of them for want of a final hash.
  const persistDeadline = new Deadline(limits.setupBudgetMs);
  await withMutationPersistence(
    context,
    changes.map((change) => change.path),
    async () => {
      const mutations: RuntimeMutationSnapshot[] = [];
      for (const change of changes) {
        // Under the path lock the hash is final for this call's purposes: it
        // is what a later builtin mutation of the path will collapse onto.
        const final = persistDeadline.expired
          ? undefined
          : await statFile(runtime, change.path, persistDeadline);
        if (!final || final.symlink) {
          complete = false;
          continue;
        }
        if (final.hash === change.before.hash) continue;
        mutations.push(toMutation(change, final.hash));
      }
      return { result: undefined, mutations };
    },
    'shell'
  );
  return complete;
}

function toMutation(change: WorkspaceChange, afterHash: string | null): RuntimeMutationSnapshot {
  const existed = change.before.hash !== null;
  return {
    path: change.path,
    op: !existed ? 'create' : afterHash === null ? 'delete' : 'edit',
    before:
      existed && change.before.contentBase64 !== undefined
        ? { exists: true, contentBase64: change.before.contentBase64, hash: change.before.hash }
        : { exists: false },
    afterHash: afterHash ?? RUNTIME_ABSENT_HASH,
  };
}

/** A path as `snapshot.hash` reports it; `hash: null` means the path is absent. */
interface ObservedFile {
  readonly hash: string | null;
  /** Undefined from a runtime that predates the stat fields. */
  readonly size: number | undefined;
  readonly modifiedAtMs: number | undefined;
  /** `hash` follows links, so this is what tells a link from the file it points at. */
  readonly symlink: boolean;
}

/** `undefined` means the runtime could not be asked or refused. */
async function statFile(
  runtime: RuntimeClient,
  path: string,
  deadline: Deadline
): Promise<ObservedFile | undefined> {
  try {
    const result = await runtime.snapshot.hash({ path }, { signal: deadline.signal });
    return {
      hash: result.hash,
      size: result.size,
      modifiedAtMs: result.modifiedAtMs,
      symlink: result.symlink === true,
    };
  } catch (error) {
    if (deadline.callerAborted) throw error;
    return undefined;
  }
}

async function listWorkspace(
  runtime: RuntimeClient,
  root: string,
  deadline: Deadline
): Promise<WorkspaceListing | null> {
  const stdout = await gitListing(
    runtime,
    root,
    ['ls-files', '-z', '-s', '-o', '--exclude-standard'],
    deadline
  );
  return stdout === null ? null : { files: parseWorkspaceListing(stdout) };
}

/**
 * Ignored files and directories as they stand before the command. Directories
 * are collapsed (`--directory`), so a `node_modules` or `target` costs one entry
 * rather than a walk of its contents.
 */
async function listIgnoredEntries(
  runtime: RuntimeClient,
  root: string,
  deadline: Deadline
): Promise<ReadonlySet<string> | null> {
  const stdout = await gitListing(
    runtime,
    root,
    ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'],
    deadline
  );
  if (stdout === null) return null;
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * Stdout of a successful, complete git call, or null for anything else. The
 * call is capped by what is left of the phase's budget, so a slow `git` on a
 * big tree cannot spend the whole 20 s default and then be followed by the
 * per-file work.
 */
async function gitListing(
  runtime: RuntimeClient,
  root: string,
  args: readonly string[],
  deadline: Deadline
): Promise<string | null> {
  try {
    const result = await runtime.git.exec(
      { args, cwd: root, timeoutMs: Math.min(GIT_TIMEOUT_MS, deadline.remainingMs) },
      { signal: deadline.signal }
    );
    return result.exitCode === 0 && !result.incomplete ? result.stdout : null;
  } catch (error) {
    if (deadline.callerAborted) throw error;
    return null;
  }
}

/**
 * A phase's time budget and the signal that enforces it on every runtime call
 * the phase makes. `caller` is the turn's own abort: when that fires the error
 * propagates like any cancelled call, whereas the budget running out only
 * degrades the snapshot.
 */
class Deadline {
  readonly signal: AbortSignal;
  private readonly endsAt: number;

  constructor(
    budgetMs: number,
    private readonly caller?: AbortSignal
  ) {
    this.endsAt = Date.now() + budgetMs;
    const budget = AbortSignal.timeout(Math.max(1, budgetMs));
    this.signal = caller ? AbortSignal.any([caller, budget]) : budget;
  }

  get expired(): boolean {
    return Date.now() >= this.endsAt;
  }

  /** At least 1 ms: a zero timeout reads as "no timeout" to some peers. */
  get remainingMs(): number {
    return Math.max(1, this.endsAt - Date.now());
  }

  get callerAborted(): boolean {
    return this.caller?.aborted === true;
  }
}

function relativeTo(paths: TargetPaths, root: string, path: string): string {
  return paths.relative(root, path).replaceAll('\\', '/');
}
