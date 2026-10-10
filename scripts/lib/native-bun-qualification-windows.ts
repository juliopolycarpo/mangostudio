import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  NATIVE_RECEIPT_ENVIRONMENT_KEYS,
  type NativeCommandOptions,
  type NativeCommandReceipt,
  type NativeProcess,
} from './native-bun-qualification-process';
import {
  NATIVE_BUILDS,
  type NativeBuildTarget,
  nativeBuildTarget,
  nativeCompilerArtifacts,
  requireNativeBuildFeatures,
} from './native-bun-qualification-source';

export interface NativeWindowsTool {
  readonly path: string;
  readonly fileVersion: string;
  readonly productVersion: string;
  readonly sha256: string;
}

export interface NativeWindowsJobContext {
  readonly helperPath: string;
  readonly helperSha256: string;
  readonly sourceSha: string;
  readonly toolingSha: string;
  /** Private runner directory outside both source and uploaded evidence. */
  readonly privateDirectory: string;
  readonly expectedVctip: readonly NativeWindowsTool[];
}

export interface NativeWindowsJobRequest {
  readonly application: string;
  readonly command: readonly string[];
  readonly root: string;
  readonly out: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mode: 'strict' | 'msvc-compile';
  readonly timeoutSeconds: number;
  readonly observationMs: number;
  readonly sourceSha: string;
  readonly workflowSha: string;
  readonly expectedVctip?: readonly NativeWindowsTool[];
}

export interface NativeWindowsWrapperResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly errors: readonly string[];
}

export type NativeWindowsJobResult = Omit<NativeCommandReceipt, 'settlement'> & {
  readonly jobReceipt: string;
  readonly settlement: {
    readonly scope: 'atomic Windows Job membership';
    readonly pollIntervalMs: number;
    readonly rootObserved: true;
    readonly observed: readonly NativeProcess[];
    readonly survivors: readonly NativeProcess[];
    readonly snapshotErrors: readonly string[];
    readonly empty: true;
  };
};

export interface NativeWindowsJobIO {
  readonly platform: NodeJS.Platform;
  readonly resolve: (
    command: string,
    root: string,
    environment: Readonly<Record<string, string>>
  ) => string | null;
  readonly read: (path: string) => Promise<Buffer>;
  readonly write: (path: string, bytes: string | Uint8Array) => Promise<void>;
  readonly append: (path: string, text: string) => Promise<void>;
  readonly prepare: (path: string, fresh?: boolean) => Promise<void>;
  readonly privateRequest: (directory: string, text: string) => Promise<string>;
  readonly removeRequest: (path: string) => Promise<void>;
  readonly execute: (
    command: readonly string[],
    request: NativeWindowsJobRequest,
    output: (source: 'stdout' | 'stderr', bytes: Buffer) => Promise<void>
  ) => Promise<NativeWindowsWrapperResult>;
}

type Row = Record<string, unknown>;

function requireValue(condition: unknown, value: unknown, expected: string): asserts condition {
  if (!condition)
    throw new Error(`Invalid Windows Job value ${JSON.stringify(value)}; expected ${expected}`);
}

function object(value: unknown, expected: string): Row {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    value,
    expected
  );
  return value as Row;
}

function list(value: unknown, expected: string): unknown[] {
  requireValue(Array.isArray(value), value, expected);
  return value as unknown[];
}

function text(value: unknown, expected: string): string {
  requireValue(
    typeof value === 'string' && value.length > 0 && !value.includes('\0'),
    value,
    expected
  );
  return value as string;
}

function date(value: unknown, expected: string): number {
  const result = Date.parse(text(value, expected));
  requireValue(Number.isFinite(result), value, expected);
  return result;
}

function integer(value: unknown, minimum: number, expected: string): number {
  requireValue(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    value,
    expected
  );
  return value as number;
}

function absolute(value: unknown): string {
  const path = text(value, 'a fully qualified Windows path without NUL');
  requireValue(
    win32.isAbsolute(path) && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path),
    value,
    'a fully qualified drive or UNC path'
  );
  return path;
}

function samePath(left: unknown, right: string): boolean {
  return win32.normalize(absolute(left)).toLowerCase() === win32.normalize(right).toLowerCase();
}

function outside(path: string, parent: string): boolean {
  const relative = win32.relative(parent, path);
  return relative.startsWith('..\\') || relative === '..' || win32.isAbsolute(relative);
}

function tool(value: unknown): NativeWindowsTool {
  const row = object(value, 'installed tool metadata');
  const result = {
    path: absolute(row.path ?? row.Path),
    fileVersion: text(row.fileVersion ?? row.FileVersion, 'the actual file version'),
    productVersion: text(row.productVersion ?? row.ProductVersion, 'the actual product version'),
    sha256: text(row.sha256 ?? row.Sha256, 'the actual tool SHA256'),
  };
  requireValue(
    /^[a-f0-9]{64}$/.test(result.sha256),
    result.sha256,
    'a lowercase 64-character SHA256'
  );
  return result;
}

function sameTool(actual: NativeWindowsTool, expected: NativeWindowsTool): boolean {
  return (
    samePath(actual.path, expected.path) &&
    actual.fileVersion === expected.fileVersion &&
    actual.productVersion === expected.productVersion &&
    actual.sha256 === expected.sha256
  );
}

function member(value: unknown): Row {
  const row = object(value, 'a live exact-job process identity');
  const pid = integer(row.Pid, 1, 'a positive native PID');
  const created = text(row.Created, 'a full 100ns UTC creation timestamp');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})Z$/.exec(created);
  const ticks = text(row.CreationFileTime, 'the decimal native FILETIME');
  requireValue(
    match && /^\d+$/.test(ticks),
    row,
    'a decimal FILETIME and full seven-digit UTC timestamp'
  );
  const expected =
    (BigInt(date(`${match[1]}Z`, 'a valid UTC creation timestamp')) + 11644473600000n) * 10000n +
    BigInt(match[2]);
  requireValue(
    BigInt(ticks) === expected &&
      row.Identity === `${pid}:${created}` &&
      row.CensusIdentity === `${pid}:${match[1]}.${match[2].slice(0, 6)}0Z`,
    row,
    'matching full creation identity and observational CIM identity'
  );
  requireValue(
    row.IsMember === true && row.Alive === true,
    row,
    'a live retained exact-job member'
  );
  absolute(row.Path);
  if (row.Tool !== null) tool(row.Tool);
  return row;
}

function snapshot(value: unknown, mustBeEmpty: boolean): Row {
  const row = object(value, 'a complete stable native membership snapshot');
  date(row.At, 'snapshot time');
  const members = list(row.Members, 'an exact-job member array').map(member);
  const count = members.length;
  for (const key of ['Assigned', 'Returned', 'ActiveBefore', 'ActiveAfter'])
    requireValue(row[key] === count, row, 'consistent complete membership and active counts');
  integer(
    row.TotalProcesses,
    Math.max(1, count),
    'cumulative native process count including the root'
  );
  integer(row.NativeBytes, 8 + count * 8, 'a complete x64 native PID buffer');
  integer(row.Races, 0, 'a nonnegative refresh race count');
  requireValue(
    row.Stable === true && row.Empty === (count === 0) && (!mustBeEmpty || count === 0),
    row,
    mustBeEmpty ? 'a stable empty still-open Job' : 'complete stable exact-job membership'
  );
  requireValue(
    new Set(members.map((item) => item.Identity)).size === count &&
      new Set(members.map((item) => item.Pid)).size === count,
    row,
    'unique exact native member identities and PIDs'
  );
  return row;
}

function census(value: unknown): Row[] {
  const rows = list(value, 'an independent full native census').map((item) => {
    const row = object(item, 'a full census row');
    const pid = integer(row.pid, 1, 'a positive census PID');
    integer(row.parentPid, 0, 'a nonnegative parent PID');
    date(row.created, 'census creation time');
    text(row.name, 'a census image name');
    requireValue(
      row.identity === `${pid}:${row.created}`,
      row,
      'a matching census creation identity'
    );
    requireValue(
      row.path === null || typeof row.path === 'string',
      row.path,
      'a string or inaccessible census image path'
    );
    requireValue(
      row.command === null || typeof row.command === 'string',
      row.command,
      'a string or inaccessible command'
    );
    requireValue(
      typeof row.compilerHelper === 'boolean',
      row.compilerHelper,
      'a recorded compiler-helper verdict'
    );
    return row;
  });
  requireValue(
    rows.length > 0 &&
      new Set(rows.map((row) => row.identity)).size === rows.length &&
      new Set(rows.map((row) => row.pid)).size === rows.length,
    value,
    'a nonempty full census with unique live process identities'
  );
  return rows;
}

/**
 * A census may carry a command line only for a process the Job itself observed. Any other
 * program's argv is not evidence and may hold its secrets, so the refusal names identities only.
 */
function ownedCommandLines(rows: Row[], owned: ReadonlySet<unknown>): void {
  const foreign = rows.filter((row) => row.command !== null && !owned.has(row.identity));
  requireValue(
    foreign.length === 0,
    foreign.map((row) => row.identity),
    'command lines recorded only for observed exact-job members'
  );
}

function compilerHelper(row: Row): boolean {
  // The helper's own verdict reads the command line it then withholds for a process outside the Job.
  return (
    row.compilerHelper === true ||
    /^(vctip|cl|link|mspdbsrv|mspdbcmf|mspdbcore|c1|c1xx|c2|ml|ml64|rc|mt)\.exe$/i.test(
      String(row.name)
    ) ||
    /[\\/]VC[\\/]Tools[\\/]MSVC[\\/]/i.test(`${row.path ?? ''} ${row.command ?? ''}`)
  );
}

function noNewHelpers(before: Row[], current: Row[]): void {
  const known = new Set(before.map((row) => row.identity));
  const unknown = current.filter((row) => !known.has(row.identity) && compilerHelper(row));
  requireValue(
    unknown.length === 0,
    unknown,
    'no new unattributed compiler helper in the full final census'
  );
}

function compilerTarget(command: readonly string[], application: string): NativeBuildTarget | null {
  if (
    win32.basename(application).toLowerCase() !== 'cargo.exe' ||
    (command[0] !== 'cargo' && win32.basename(command[0]) !== 'cargo.exe')
  )
    return null;
  return nativeBuildTarget(command);
}

function compilerProof(
  bytes: Uint8Array,
  request: NativeWindowsJobRequest,
  eligibility: Row
): void {
  const log = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows: Row[] = log
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => object(JSON.parse(line), 'a Cargo JSON message'));
  requireValue(
    rows.length > 0 &&
      rows.at(-1)?.reason === 'build-finished' &&
      rows.at(-1)?.success === true &&
      rows.filter((row) => row.reason === 'build-finished').length === 1 &&
      rows.every((row) =>
        [
          'compiler-artifact',
          'compiler-message',
          'build-script-executed',
          'build-finished',
        ].includes(String(row.reason))
      ),
    rows,
    'one final successful build-finished and only complete Cargo messages'
  );
  const artifacts = nativeCompilerArtifacts(log);
  const target = compilerTarget(request.command, request.application);
  requireValue(target, request.command, 'one of the two exact separate compiler argv');
  const features = JSON.stringify(NATIVE_BUILDS[target].sdkFeatures);
  const { sdk, primary } = requireNativeBuildFeatures(artifacts, target);
  for (const artifact of primary) absolute(artifact.executable);
  requireValue(
    eligibility.eligible === true &&
      eligibility.buildTarget === target &&
      eligibility.buildFinished === true &&
      list(eligibility.reasons, 'compiler refusal reasons').length === 0 &&
      eligibility.artifactCount === artifacts.length,
    eligibility,
    'complete independent compiler eligibility matching raw stdout and original target'
  );
  const declared = list(eligibility.sdkFeatures, 'reported SDK feature sets');
  requireValue(
    declared.length === sdk.length &&
      declared.every(
        (value) => JSON.stringify(list(value, 'SDK feature array').slice().sort()) === features
      ),
    declared,
    'eligibility features matching the original Cargo receipt'
  );
}

/**
 * Hold one pre-cleanup member's record, a termination or a natural exit, to the member's
 * retained creation identity and to the independently attested VCTIP it must be.
 */
function vctipRecord(
  record: Row,
  members: Row[],
  identities: Set<string>,
  request: NativeWindowsJobRequest
): void {
  const owned = members.find((item) => item.Identity === record.identity);
  requireValue(
    owned && !identities.has(String(record.identity)),
    record,
    'one retained full creation identity from the pre-cleanup Job'
  );
  identities.add(String(record.identity));
  const actual = tool(record.tool);
  const attested = request.expectedVctip?.find((item) => samePath(actual.path, item.path));
  requireValue(
    attested &&
      sameTool(actual, attested) &&
      samePath(owned.Path, attested.path) &&
      sameTool(tool(owned.Tool), actual),
    record,
    'actual installed VCTIP path, versions and hash matching the retained member'
  );
  requireValue(
    record.pid === owned.Pid &&
      record.creationFileTime === owned.CreationFileTime &&
      samePath(record.path, actual.path),
    record,
    'the same exact retained VCTIP process identity'
  );
}

function cleanupProof(row: Row, request: NativeWindowsJobRequest, pre: Row): void {
  const actions = list(row.cleanupActions, 'explicit retained-member cleanup actions').map(
    (value) => object(value, 'a cleanup action')
  );
  // An eligible VCTIP may finish by itself while the helper writes its evidence. That is
  // settlement, not a failure, but only with the same identity proof a termination needs.
  const exits = list(row.naturalExits, 'natural exits of eligible compiler members').map((value) =>
    object(value, 'a natural exit')
  );
  const members = list(pre.Members, 'pre-cleanup members').map(member);
  requireValue(
    row.status ===
      (actions.length ? 'qualified-after-explicit-compiler-cleanup' : 'naturally-settled'),
    row.status,
    'a status consistent with explicit cleanup'
  );
  requireValue(
    actions.length + exits.length === members.length &&
      ((!actions.length && !exits.length) || request.mode === 'msvc-compile'),
    { cleanupActions: actions.length, naturalExits: exits.length, members: members.length },
    'exactly one explicit compiler action or natural exit per surviving member, and no strict cleanup or exit allowance'
  );
  const identities = new Set<string>();
  for (const exit of exits) {
    vctipRecord(exit, members, identities, request);
    const remaining = list(
      snapshot(exit.snapshot, false).Members,
      'members remaining after the natural exit'
    ).map(member);
    requireValue(
      exit.authority === 'retained creation identity + complete stable exact job membership' &&
        exit.observation === 'eligible VCTIP member left the still-open job before any cleanup' &&
        remaining.every((item) => item.Identity !== exit.identity),
      exit,
      'a complete stable still-open Job snapshot that no longer lists the eligible VCTIP member'
    );
    requireValue(
      date(exit.at, 'natural exit time') >= date(row.rootExitAt, 'root exit time') &&
        date(exit.at, 'natural exit time') <= date(row.finishedAt, 'receipt finish time'),
      exit,
      'a natural exit observed after root exit and before receipt completion'
    );
  }
  for (const action of actions) {
    vctipRecord(action, members, identities, request);
    requireValue(
      action.authority === 'retained process handle + creation identity + exact job membership' &&
        action.operation === 'TerminateProcess' &&
        action.requested === true &&
        action.completed === true,
      action,
      'completed termination on the same exact retained VCTIP process object'
    );
    requireValue(
      action.reason ===
        'successful default compiler setup completed and both raw pipes reached EOF',
      action.reason,
      'the explicit successful compiler-completion reason'
    );
    requireValue(
      date(action.at, 'cleanup request time') >= date(row.rootExitAt, 'root exit time') &&
        date(action.completedAt, 'cleanup completion time') >=
          date(action.at, 'cleanup request time') &&
        date(action.completedAt, 'cleanup completion time') <=
          date(row.finishedAt, 'receipt finish time'),
      action,
      'completed cleanup after root exit and before receipt completion'
    );
  }
}

/**
 * Reject incomplete or contradictory helper evidence before certifying still-open Job settlement.
 * Raw compiler stdout is checked independently; kill-on-close containment never establishes success.
 * @example parseNativeWindowsJobReceipt(json, request, context.helperSha256, wrapper, rawStdout);
 */
export function parseNativeWindowsJobReceipt(
  json: string,
  request: NativeWindowsJobRequest,
  helperSha256: string,
  wrapper: NativeWindowsWrapperResult,
  stdout: Uint8Array
): NativeWindowsJobResult {
  requireValue(
    request.mode ===
      (compilerTarget(request.command, request.application) ? 'msvc-compile' : 'strict'),
    request.command,
    'mode derived from the exact separate compiler argv'
  );
  requireValue(
    wrapper.exitCode === 0 &&
      wrapper.signal === null &&
      wrapper.timedOut === false &&
      wrapper.errors.length === 0,
    wrapper,
    'a successful complete PowerShell wrapper exit'
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid Windows Job receipt ${JSON.stringify(json)}; expected complete JSON`, {
      cause: error,
    });
  }
  const row = object(parsed, 'a complete Job receipt');
  requireValue(
    row.schemaVersion === 1 &&
      ['naturally-settled', 'qualified-after-explicit-compiler-cleanup'].includes(
        String(row.status)
      ),
    row,
    'a completed successful schemaVersion1 receipt'
  );
  requireValue(
    row.sourceSha === request.sourceSha &&
      row.workflowSha === request.workflowSha &&
      row.helperSha256 === helperSha256 &&
      row.root === request.root &&
      row.application === request.application &&
      row.mode === request.mode &&
      JSON.stringify(row.command) === JSON.stringify(request.command),
    row,
    'the sealed source, tooling, helper, original argv, application, cwd and mode'
  );
  requireValue(
    row.os64Bit === true &&
      row.process64Bit === true &&
      row.timeoutSeconds === request.timeoutSeconds &&
      row.observationMs === request.observationMs &&
      row.exitCode === 0 &&
      row.timedOut === false &&
      row.stdoutEof === true &&
      row.stderrEof === true &&
      list(row.errors, 'helper errors').length === 0 &&
      list(row.ambiguity, 'unattributed helpers').length === 0,
    row,
    'Windows x64 exit0, both raw pipe EOFs, original deadlines, no errors or ambiguity'
  );
  const started = date(row.startedAt, 'start time');
  const finished = date(row.finishedAt, 'finish time');
  const exited = date(row.rootExitAt, 'root exit time');
  requireValue(
    started <= exited && exited <= finished,
    row,
    'ordered start, root exit and completed receipt times'
  );
  const root = member(row.rootIdentity);
  requireValue(
    samePath(root.Path, request.application),
    root,
    'the originally resolved suspended native application'
  );
  const job = object(row.job, 'atomic private Job configuration');
  requireValue(
    job.atomicJobList === true &&
      job.suspended === true &&
      job.inherited === false &&
      job.limitFlags === 0x2000 &&
      job.creationFlags === 0x80404 &&
      job.breakaway === false &&
      job.notificationsAuthority === false,
    job,
    'atomic suspended JOB_LIST assignment, private kill-on-close handle, no breakaway or notification authority'
  );
  const natural = object(
    row.naturalSettlement,
    'natural settlement evidence recorded before cleanup'
  );
  const naturalSnapshot = snapshot(natural.snapshot, false);
  requireValue(
    natural.empty === naturalSnapshot.Empty &&
      integer(natural.observedMs, 0, 'natural observation duration') >= request.observationMs,
    natural,
    'the original natural observation bound and matching snapshot'
  );
  const pre = snapshot(row.preCleanup, false);
  snapshot(row.postCleanup, true);
  cleanupProof(row, request, pre);
  const eligibility = object(row.eligibility, 'compiler eligibility evidence');
  requireValue(
    typeof eligibility.eligible === 'boolean' && typeof eligibility.buildFinished === 'boolean',
    eligibility,
    'complete boolean compiler eligibility'
  );
  integer(eligibility.artifactCount, 0, 'a nonnegative compiler artifact count');
  for (const reason of list(eligibility.reasons, 'compiler refusal reasons'))
    text(reason, 'a compiler refusal reason');
  for (const features of list(eligibility.sdkFeatures, 'reported SDK features'))
    for (const feature of list(features, 'an SDK feature set')) text(feature, 'an SDK feature');
  if (request.mode === 'msvc-compile') {
    try {
      compilerProof(stdout, request, eligibility);
    } catch (error) {
      throw new Error(
        `Invalid Cargo stdout at ${win32.join(request.out, 'logs', 'stdout.log')}: ${String(error)}; expected complete UTF8 JSON, original features and compiler eligibility`,
        { cause: error }
      );
    }
  } else
    requireValue(
      eligibility.eligible === false,
      eligibility,
      'strict mode with no compiler cleanup eligibility'
    );
  const before = census(row.before);
  const preCensus = census(row.preCleanupCensus);
  noNewHelpers(before, census(row.postCleanupCensus));
  const mappings = list(row.censusMappings, 'native/CIM consistency mappings').map((value) =>
    object(value, 'a native/CIM mapping')
  );
  for (const mapping of mappings)
    requireValue(
      mapping.exactJobMember === true &&
        mapping.live === true &&
        mapping.retainedMemberMatched === true &&
        mapping.queryError === null &&
        list(pre.Members, 'pre-cleanup members').some((value) => {
          const owned = member(value);
          return (
            mapping.censusIdentity === owned.CensusIdentity &&
            mapping.nativeIdentity === owned.Identity &&
            mapping.nativeCreationFileTime === owned.CreationFileTime
          );
        }),
      mapping,
      'successful native/CIM mappings to retained pre-cleanup members'
    );
  const known = new Set(before.map((item) => item.identity));
  for (const current of preCensus.filter(
    (item) => !known.has(item.identity) && compilerHelper(item)
  )) {
    const owned = list(pre.Members, 'pre-cleanup members')
      .map(member)
      .find((item) => item.CensusIdentity === current.identity);
    requireValue(
      owned &&
        mappings.some(
          (item) =>
            item.censusIdentity === current.identity &&
            item.nativeIdentity === owned.Identity &&
            item.nativeCreationFileTime === owned.CreationFileTime &&
            item.exactJobMember === true &&
            item.live === true &&
            item.retainedMemberMatched === true &&
            item.queryError === null
        ),
      current,
      'a fresh exact-job native handle mapping for every new CIM compiler helper'
    );
  }
  const final = object(row.finalClose, 'the last still-open Job boundary');
  snapshot(final.preClose, true);
  requireValue(
    date(final.at, 'final open-Job boundary time') >= exited &&
      date(final.at, 'final open-Job boundary time') <= finished,
    final.at,
    'a final still-open Job boundary between root exit and receipt completion'
  );
  requireValue(
    final.queryError === null &&
      final.outcomeBeforeClose === row.status &&
      final.operation === 'CloseHandle(private kill-on-close job)' &&
      final.successfulSettlementEvidence === false,
    final,
    'successful settlement before close, with containment excluded as evidence'
  );
  noNewHelpers(before, census(final.census));
  noNewHelpers(before, census(row.postCloseCensus));
  const observed = list(row.observed, 'observed exact-job members').map(member);
  requireValue(
    new Set(observed.map((item) => item.Identity)).size === observed.length,
    observed,
    'unique observed full process identities'
  );
  const owned = new Set(observed.map((item) => item.CensusIdentity));
  for (const recorded of [
    row.before,
    row.preCleanupCensus,
    row.postCleanupCensus,
    final.census,
    row.postCloseCensus,
  ])
    ownedCommandLines(census(recorded), owned);
  return {
    label: '',
    command: request.command,
    environment: {},
    startedAt: String(row.startedAt),
    finishedAt: String(row.finishedAt),
    durationMs: finished - started,
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutSeconds: request.timeoutSeconds,
    errors: [],
    log: '',
    jobReceipt: win32.join(request.out, 'job-receipt.json'),
    settlement: {
      scope: 'atomic Windows Job membership',
      pollIntervalMs: 100,
      rootObserved: true,
      observed: observed.map((item) => ({
        pid: Number(item.Pid),
        parentPid: 0,
        group: null,
        // The legacy census matches CIM keys; full100ns authority remains in jobReceipt.
        identity: String(item.CensusIdentity),
        command: '',
        executablePath: String(item.Path),
      })),
      survivors: [],
      snapshotErrors: [],
      empty: true,
    },
  };
}

/**
 * The bounded work `native-windows-job.ps1` does outside its command stopwatch. Its source is
 * pinned to these values by `native-bun-qualification-powershell.unit.test.ts`.
 */
export const NATIVE_WINDOWS_HELPER_PHASES = {
  /** PowerShell start, `Add-Type` compilation and the helper hash; the helper does not bound it. */
  startupMs: 60_000,
  /** Baseline, pre-cleanup, post-cleanup, final open-job and post-close censuses. */
  censusCount: 5,
  /** `Get-CimInstance -OperationTimeoutSec`. */
  censusTimeoutMs: 10_000,
  /** One ambiguity pass after every census but the baseline. */
  ambiguityPassCount: 4,
  /**
   * `ImageQueryBudget.MaximumMilliseconds`, allowed once per ambiguity pass. The helper grants
   * it per queried row, so this is an allowance for one slow row per pass, not a bound.
   */
  imageQueryBudgetMs: 10_000,
  /** One `TerminateVerifiedMember` wait. The helper waits per eligible member, normally one. */
  terminationWaitMs: 5_000,
  /** The wait for an empty Job after cleanup. */
  postCleanupMs: 5_000,
} as const;

/**
 * How long the PowerShell wrapper may live before it is contained: the command's own cap and
 * observation window, plus every bounded phase the helper runs outside its command stopwatch.
 * @example setTimeout(contain, nativeWindowsWrapperDeadlineMs({ timeoutSeconds: 900, observationMs: 5000 }));
 */
export function nativeWindowsWrapperDeadlineMs(
  request: Pick<NativeWindowsJobRequest, 'timeoutSeconds' | 'observationMs'>
): number {
  const phases = NATIVE_WINDOWS_HELPER_PHASES;
  return (
    request.timeoutSeconds * 1000 +
    request.observationMs +
    phases.startupMs +
    phases.censusCount * phases.censusTimeoutMs +
    phases.ambiguityPassCount * phases.imageQueryBudgetMs +
    phases.terminationWaitMs +
    phases.postCleanupMs
  );
}

async function executeHelper(
  command: readonly string[],
  request: NativeWindowsJobRequest,
  output: (source: 'stdout' | 'stderr', bytes: Buffer) => Promise<void>
): Promise<NativeWindowsWrapperResult> {
  const errors: string[] = [];
  let closed = false;
  let timedOut = false;
  let resolveUnclosed: (() => void) | undefined;
  let containmentTimer: ReturnType<typeof setTimeout> | undefined;
  const unclosed = new Promise<{ exitCode: null; signal: null }>((resolve) => {
    resolveUnclosed = () => resolve({ exitCode: null, signal: null });
  });
  const child = spawn(command[0], command.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on('error', (error) => errors.push(String(error)));
    child.on('close', (exitCode, signal) => {
      closed = true;
      resolve({ exitCode, signal });
    });
  });
  const diagnostics = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  child.stdout.on('data', (bytes: Buffer) => diagnostics.stdout.push(bytes));
  child.stderr.on('data', (bytes: Buffer) => diagnostics.stderr.push(bytes));
  const offsets = { stdout: 0, stderr: 0 };
  const readOutput = async (source: 'stdout' | 'stderr'): Promise<void> => {
    const path = win32.join(request.out, 'logs', `${source}.log`);
    let file: FileHandle;
    try {
      file = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const size = (await file.stat()).size;
      requireValue(size >= offsets[source], size, 'append-only raw helper logs');
      while (offsets[source] < size) {
        const bytes = Buffer.alloc(Math.min(65536, size - offsets[source]));
        const read = await file.read(bytes, 0, bytes.length, offsets[source]);
        requireValue(read.bytesRead > 0, read.bytesRead, 'complete raw log bytes');
        offsets[source] += read.bytesRead;
        await output(source, bytes.subarray(0, read.bytesRead));
      }
    } finally {
      await file.close();
    }
  };
  const contain = (): void => {
    child.kill('SIGKILL');
    containmentTimer ??= setTimeout(() => {
      errors.push(
        'PowerShell wrapper did not close after bounded own-process termination; expected close within5000ms'
      );
      closed = true;
      resolveUnclosed?.();
    }, 5000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    contain();
  }, nativeWindowsWrapperDeadlineMs(request));
  try {
    while (!closed) {
      await readOutput('stdout');
      await readOutput('stderr');
      await Promise.race([completion, unclosed, Bun.sleep(100)]);
    }
    await readOutput('stdout');
    await readOutput('stderr');
  } catch (error) {
    errors.push(String(error));
    contain();
  }
  const exit = await Promise.race([completion, unclosed]);
  clearTimeout(timer);
  clearTimeout(containmentTimer);
  await writeFile(win32.join(request.out, 'wrapper.stdout.log'), Buffer.concat(diagnostics.stdout));
  await writeFile(win32.join(request.out, 'wrapper.stderr.log'), Buffer.concat(diagnostics.stderr));
  return { ...exit, timedOut, errors };
}

const defaultIO: NativeWindowsJobIO = {
  platform: process.platform,
  resolve: (command, root, environment) =>
    Bun.which(command, {
      cwd: root,
      PATH: Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '',
    }),
  read: readFile,
  write: writeFile,
  append: appendFile,
  prepare: async (path, fresh = false) => {
    await mkdir(path, { recursive: !fresh });
  },
  privateRequest: async (directory, value) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const folder = await mkdtemp(win32.join(directory, 'native-job-'));
    const path = win32.join(folder, 'request.json');
    try {
      await writeFile(path, value, { mode: 0o600, flag: 'wx' });
      return path;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  },
  removeRequest: async (path) => {
    await rm(win32.dirname(path), { recursive: true, force: true });
  },
  execute: executeHelper,
};

/**
 * Invoke sealed native Job tooling with private inherited environment and preserve original raw output.
 * Only the exact separate runtime/fake Cargo setup commands permit attested VCTIP cleanup.
 * @example await runNativeWindowsJob(commandOptions, { helperPath, helperSha256, sourceSha, toolingSha, privateDirectory, expectedVctip });
 */
export async function runNativeWindowsJob(
  options: NativeCommandOptions,
  context: NativeWindowsJobContext,
  io: NativeWindowsJobIO = defaultIO
): Promise<NativeWindowsJobResult> {
  requireValue(io.platform === 'win32', io.platform, 'native Windows execution');
  requireValue(/^[a-z0-9][a-z0-9-]*$/.test(options.label), options.label, 'a safe command label');
  for (const path of [options.root, options.out, context.helperPath, context.privateDirectory])
    absolute(path);
  requireValue(
    outside(options.out, options.root) &&
      outside(context.helperPath, options.root) &&
      outside(context.privateDirectory, options.root) &&
      outside(context.privateDirectory, options.out),
    context.privateDirectory,
    'separate sealed helper and private requests outside source and uploaded evidence, with evidence outside source'
  );
  requireValue(
    /^[a-f0-9]{40}$/.test(context.sourceSha) &&
      /^[a-f0-9]{40}$/.test(context.toolingSha) &&
      /^[a-f0-9]{64}$/.test(context.helperSha256),
    context,
    'sealed source/tooling commits and helper SHA256'
  );
  requireValue(
    Number.isFinite(options.timeoutSeconds) &&
      options.timeoutSeconds > 0 &&
      options.timeoutSeconds <= 900,
    options.timeoutSeconds,
    'timeout greater than0 and at most900 seconds'
  );
  const observationMs = options.settleMs ?? 5000;
  requireValue(
    Number.isSafeInteger(observationMs) && observationMs >= 0 && observationMs <= 30000,
    observationMs,
    'observation0..30000ms'
  );
  requireValue(options.command.length > 0, options.command, 'original nonempty argv');
  text(options.command[0], 'a nonempty original argv0');
  for (const value of options.command)
    requireValue(
      typeof value === 'string' && !value.includes('\0'),
      value,
      'an original argv string without NUL'
    );
  const environment: Record<string, string> = Object.create(null);
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(options.env)) {
    text(key, 'an environment key without NUL');
    requireValue(
      !key.includes('=') && !keys.has(key.toLowerCase()),
      key,
      'unique case-insensitive environment keys without='
    );
    keys.add(key.toLowerCase());
    if (value === undefined) continue;
    requireValue(
      typeof value === 'string' && !value.includes('\0'),
      key,
      'string environment values without NUL'
    );
    environment[key] = value;
  }
  const application = absolute(io.resolve(options.command[0], options.root, environment));
  const shell = absolute(io.resolve('powershell.exe', options.root, environment));
  const mode = compilerTarget(options.command, application) ? 'msvc-compile' : 'strict';
  const attested = list(
    context.expectedVctip,
    'an independently attested installed VCTIP array'
  ).map(tool);
  requireValue(
    new Set(attested.map((item) => win32.normalize(item.path).toLowerCase())).size ===
      attested.length &&
      attested.every((item) =>
        /[\\/]VC[\\/]Tools[\\/]MSVC[\\/][^\\/]+[\\/]bin[\\/]Hostx64[\\/]x64[\\/]vctip\.exe$/i.test(
          item.path
        )
      ) &&
      (mode === 'strict' || attested.length > 0),
    attested,
    'independently attested installed Hostx64/x64 VCTIP paths; nonempty for compiler mode'
  );
  const actualHash = createHash('sha256')
    .update(await io.read(context.helperPath))
    .digest('hex');
  requireValue(
    actualHash === context.helperSha256,
    actualHash,
    `sealed helper SHA256 ${context.helperSha256}`
  );
  const jobOut = win32.join(options.out, 'windows-jobs', options.label);
  await io.prepare(win32.dirname(jobOut));
  await io.prepare(jobOut, true);
  await io.prepare(win32.join(options.out, 'logs'));
  const log = `logs/${options.label}.log`;
  const combined = win32.join(options.out, log);
  await io.write(combined, '');
  const request: NativeWindowsJobRequest = {
    application,
    command: options.command,
    root: options.root,
    out: jobOut,
    environment,
    mode,
    timeoutSeconds: options.timeoutSeconds,
    observationMs,
    sourceSha: context.sourceSha,
    workflowSha: context.toolingSha,
    ...(mode === 'msvc-compile' ? { expectedVctip: attested } : {}),
  };
  const pending = { stdout: '', stderr: '' };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const output = async (source: 'stdout' | 'stderr', bytes: Buffer): Promise<void> => {
    (options.stream ?? process.stdout).write(bytes);
    pending[source] += decoders[source].write(bytes);
    const boundary = pending[source].lastIndexOf('\n');
    if (boundary >= 0) {
      await io.append(combined, pending[source].slice(0, boundary + 1));
      pending[source] = pending[source].slice(boundary + 1);
    }
    requireValue(
      pending[source].length <= 1048576,
      pending[source].length,
      'text reporter lines bounded to1MiB'
    );
  };
  let privatePath: string | null = null;
  try {
    privatePath = await io.privateRequest(context.privateDirectory, JSON.stringify(request));
    const wrapper = await io.execute(
      [
        shell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        context.helperPath,
        '-RequestPath',
        privatePath,
      ],
      request,
      output
    );
    for (const source of ['stdout', 'stderr'] as const) {
      pending[source] += decoders[source].end();
      if (pending[source]) await io.append(combined, `${pending[source]}\n`);
    }
    const stdout = await io.read(win32.join(jobOut, 'logs', 'stdout.log'));
    const stderr = await io.read(win32.join(jobOut, 'logs', 'stderr.log'));
    await io.write(win32.join(options.out, 'logs', `${options.label}.stdout.log`), stdout);
    await io.write(win32.join(options.out, 'logs', `${options.label}.stderr.log`), stderr);
    const result = parseNativeWindowsJobReceipt(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await io.read(win32.join(jobOut, 'job-receipt.json'))
      ),
      request,
      context.helperSha256,
      wrapper,
      stdout
    );
    return {
      ...result,
      label: options.label,
      log,
      environment: Object.fromEntries(
        NATIVE_RECEIPT_ENVIRONMENT_KEYS.map((key) => [key, environment[key] ?? null])
      ),
    };
  } catch (error) {
    throw new Error(
      `Native Windows Job ${JSON.stringify(options.label)} failed: ${String(error)}; expected complete sealed command evidence`,
      { cause: error }
    );
  } finally {
    if (privatePath) await io.removeRequest(privatePath);
  }
}
