import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface NativeProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number | null;
  readonly identity: string;
  readonly command: string;
  readonly name?: string;
  readonly executablePath?: string | null;
}

export interface NativeProcessScope {
  readonly rootPid: number;
  readonly rootAlive: boolean;
  readonly rootIdentity: string | null;
  readonly observed: readonly NativeProcess[];
}

interface NativeSettlement {
  readonly scope:
    | 'observed descendants and command process group'
    | 'atomic Windows Job membership';
  readonly pollIntervalMs: number;
  readonly rootObserved: boolean;
  readonly observed: readonly NativeProcess[];
  readonly survivors: readonly NativeProcess[];
  readonly snapshotErrors: readonly string[];
  readonly unattributedCompilerHelpers?: readonly NativeProcess[];
  readonly empty: boolean;
}

export interface NativeCommandReceipt {
  readonly label: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | null>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly timeoutSeconds: number;
  readonly errors: readonly string[];
  readonly log: string;
  readonly settlement: NativeSettlement;
}

export interface NativeCommandOptions {
  readonly label: string;
  readonly command: readonly string[];
  readonly root: string;
  readonly out: string;
  readonly env: Record<string, string | undefined>;
  readonly timeoutSeconds: number;
  readonly snapshot?: () => Promise<readonly NativeProcess[]>;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
  readonly stream?: NodeJS.WritableStream;
  readonly guardCompilerHelpers?: boolean;
}

/**
 * Decode native process snapshots, rejecting malformed rows rather than returning an empty census.
 * @example parseNativeProcesses(await powershellOutput(), 'win32');
 */
export function parseNativeProcesses(text: string, platform: NodeJS.Platform): NativeProcess[] {
  if (platform === 'win32') {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error(`Invalid CIM snapshot ${text}; expected a JSON array containing processes`);
    return parsed.map((value: Record<string, unknown>) => {
      const pid = Number(value.pid);
      const parentPid = Number(value.parentPid);
      if (
        !Number.isInteger(pid) ||
        pid < 0 ||
        !Number.isInteger(parentPid) ||
        typeof value.created !== 'string' ||
        !value.created ||
        !Number.isFinite(Date.parse(value.created)) ||
        (value.name !== undefined && typeof value.name !== 'string') ||
        (value.executablePath !== undefined &&
          value.executablePath !== null &&
          typeof value.executablePath !== 'string')
      ) {
        throw new Error(
          `Invalid CIM process ${JSON.stringify(value)}; expected PID, parent PID, and creation time; optional string image metadata`
        );
      }
      return {
        pid,
        parentPid,
        group: null,
        identity: `${pid}:${value.created}`,
        command: String(value.command ?? ''),
        ...(value.name !== undefined ? { name: value.name as string } : {}),
        ...(value.executablePath !== undefined
          ? { executablePath: value.executablePath as string | null }
          : {}),
      };
    });
  }
  if (!text.trim()) throw new Error('Empty ps snapshot; expected the observer process to exist');
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(
          line
        );
      if (!match)
        throw new Error(
          `Invalid ps row ${JSON.stringify(line)}; expected PID PPID PGID lstart command`
        );
      const pid = Number(match[1]);
      return {
        pid,
        parentPid: Number(match[2]),
        group: Number(match[3]),
        identity: `${pid}:${match[4]}`,
        command: match[5],
      };
    });
}

function processStart(row: NativeProcess): { clock: 'ticks' | 'time'; value: bigint } | null {
  const prefix = `${row.pid}:`;
  if (!row.identity.startsWith(prefix)) return null;
  const text = row.identity.slice(prefix.length);
  if (/^\d+$/.test(text)) return { clock: 'ticks', value: BigInt(text) };
  const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|\+00:00)$/.exec(text);
  if (utc) {
    const milliseconds = Date.parse(`${utc[1]}${utc[3]}`);
    if (!Number.isFinite(milliseconds)) return null;
    // Preserve CIM's reported fractional seconds; Date.parse reduces them to milliseconds.
    const fraction = BigInt((utc[2] ?? '').padEnd(7, '0'));
    return { clock: 'time', value: BigInt(milliseconds) * 10_000n + fraction };
  }
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    ? { clock: 'time', value: BigInt(milliseconds) * 10_000n }
    : null;
}

function validParentEdge(child: NativeProcess, parent: NativeProcess): boolean {
  const childStart = processStart(child);
  const parentStart = processStart(parent);
  if (childStart && parentStart && childStart.clock === parentStart.clock)
    return childStart.value >= parentStart.value;
  // POSIX reports a current parent; Windows retains its creation-time parent PID after reuse.
  return child.group !== null && parent.group !== null;
}

async function captureSnapshot(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Snapshot ${command[0]} exited ${code}: ${error}; expected a complete process census`
    );
  return out;
}

/**
 * Read native process identities. Linux adds /proc start ticks to avoid PID reuse within a second.
 * @example const processes = await snapshotNativeProcesses();
 */
export async function snapshotNativeProcesses(): Promise<NativeProcess[]> {
  if (process.platform === 'win32') {
    const shell = Bun.which('pwsh.exe') ?? Bun.which('powershell.exe') ?? Bun.which('pwsh');
    if (!shell)
      throw new Error('Missing PowerShell; expected native CIM process census on Windows');
    const script =
      "$ErrorActionPreference = 'Stop'; $rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o'); command = $_.CommandLine; name = $_.Name; executablePath = $_.ExecutablePath } }); ConvertTo-Json -InputObject $rows -Compress -Depth 3";
    return parseNativeProcesses(
      await captureSnapshot([
        shell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]),
      'win32'
    );
  }
  const processes = parseNativeProcesses(
    await captureSnapshot(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,args=']),
    process.platform
  );
  if (process.platform !== 'linux') return processes;
  const identities = await Promise.all(processes.map((row) => readLinuxProcessIdentity(row)));
  return identities.filter((row): row is NativeProcess => row !== null);
}

/**
 * Read a Linux process's current parent, group and start ticks, omitting an exited process.
 * @example const current = await readLinuxProcessIdentity(processRow);
 */
export async function readLinuxProcessIdentity(
  row: NativeProcess,
  readStat: (path: string, encoding: 'utf8') => Promise<string> = readFile
): Promise<NativeProcess | null> {
  try {
    const stat = await readStat(`/proc/${row.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (!/^\d+$/.test(fields[19] ?? ''))
      throw new Error(
        `Invalid /proc/${row.pid}/stat start ticks ${JSON.stringify(fields[19])}; expected decimal digits`
      );
    return {
      ...row,
      parentPid: Number(fields[1]),
      group: Number(fields[2]),
      identity: `${row.pid}:${fields[19]}`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
}

/**
 * Block newly born VCTIP helpers whose ownership the command census cannot establish.
 * This grants no termination authority; preexisting and already owned identities are excluded.
 * @example unattributedNativeCompilerHelpers(before, after, settlement.observed);
 */
export function unattributedNativeCompilerHelpers(
  before: readonly NativeProcess[],
  after: readonly NativeProcess[],
  owned: readonly NativeProcess[]
): NativeProcess[] {
  const known = new Set([...before, ...owned].map((row) => row.identity));
  return after.filter((row) => {
    if (known.has(row.identity)) return false;
    const image = row.executablePath?.replaceAll('\\', '/').split('/').at(-1);
    return /^vctip\.exe$/i.test(row.name ?? '') || /^vctip\.exe$/i.test(image ?? '');
  });
}

/**
 * Adopt descendants only through a live owned identity, retaining reparented observed descendants.
 * A reused PID does not inherit ownership from an earlier process with that PID.
 * @example scopeNativeProcesses(snapshot, { rootPid: 42, rootAlive: true, rootIdentity: null, observed: [] });
 */
export function scopeNativeProcesses(
  snapshot: readonly NativeProcess[],
  scope: NativeProcessScope
): { rootIdentity: string | null; observed: NativeProcess[]; current: NativeProcess[] } {
  const root = snapshot.find((row) => row.pid === scope.rootPid);
  const rootIdentity = scope.rootIdentity ?? (scope.rootAlive ? (root?.identity ?? null) : null);
  const observed = new Map(scope.observed.map((row) => [row.identity, row]));
  const current = new Map(
    snapshot.filter((row) => observed.has(row.identity)).map((row) => [row.identity, row])
  );
  if (root && scope.rootAlive && root.identity === rootIdentity) current.set(root.identity, root);
  let changed = true;
  while (changed) {
    changed = false;
    const ownedPids = new Map([...current.values()].map((row) => [row.pid, row]));
    const groupAnchored = [...current.values()].some((row) => row.group === scope.rootPid);
    for (const row of snapshot) {
      if (current.has(row.identity)) continue;
      const parent = ownedPids.get(row.parentPid);
      const ownedParent = parent ? validParentEdge(row, parent) : false;
      if (!ownedParent && !(groupAnchored && row.group === scope.rootPid)) continue;
      current.set(row.identity, row);
      changed = true;
    }
  }
  for (const row of current.values()) observed.set(row.identity, row);
  return { rootIdentity, observed: [...observed.values()], current: [...current.values()] };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream one attempt, retain raw output and owned identities, then require terminal settlement.
 * Timeouts terminate only this command's verified scope; no command is retried.
 * @example await runNativeCommand({ label: 'test', command: ['bun', 'run', 'test'], root, out, env, timeoutSeconds: 900 });
 */
export async function runNativeCommand(
  options: NativeCommandOptions
): Promise<NativeCommandReceipt> {
  const command = options.command[0];
  if (!command)
    throw new Error(`Empty command ${JSON.stringify(options.command)}; expected an executable`);
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)
    throw new Error(
      `Invalid timeout ${options.timeoutSeconds}; expected a positive finite number of seconds`
    );
  const started = Date.now();
  const snapshot = options.snapshot ?? snapshotNativeProcesses;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const errors: string[] = [];
  const snapshotErrors: string[] = [];
  await mkdir(join(options.out, 'logs'), { recursive: true });
  const guardCompilerHelpers = options.guardCompilerHelpers ?? process.platform === 'win32';
  let before: readonly NativeProcess[] = [];
  if (guardCompilerHelpers) {
    try {
      before = await snapshot();
      await Bun.write(
        join(options.out, `processes-before-${options.label}.json`),
        `${JSON.stringify(before, null, 2)}\n`
      );
    } catch (error) {
      snapshotErrors.push(`Compiler-helper baseline census failed: ${String(error)}`);
    }
  }
  let unattributedCompilerHelpers: NativeProcess[] = [];
  const log = `logs/${options.label}.log`;
  const combined = createWriteStream(join(options.out, log));
  const rawOut = createWriteStream(join(options.out, `logs/${options.label}.stdout.log`));
  const rawError = createWriteStream(join(options.out, `logs/${options.label}.stderr.log`));
  const stream = options.stream ?? process.stdout;
  for (const writer of [combined, rawOut, rawError])
    writer.on('error', (error) => errors.push(`Log write failed: ${String(error)}`));
  const child = spawn(command, options.command.slice(1), {
    cwd: options.root,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tee = (source: NodeJS.ReadableStream, writer: NodeJS.WritableStream): void => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    source.on('data', (chunk: Buffer) => {
      writer.write(chunk);
      stream.write(chunk);
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        combined.write(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (pending.length > 1_048_576) {
        errors.push('Output line exceeds 1 MiB; expected bounded text reporter lines');
        combined.write(`${pending}\n`);
        pending = '';
      }
    });
    source.on('end', () => {
      pending += decoder.end();
      if (pending) combined.write(`${pending}\n`);
    });
  };
  tee(child.stdout, rawOut);
  tee(child.stderr, rawError);
  let exited = false;
  let timedOut = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let rootIdentity: string | null = null;
  let observed: NativeProcess[] = [];
  let current: NativeProcess[] = [];
  let resolveExecution: (() => void) | undefined;
  const execution = new Promise<void>((resolve) => {
    resolveExecution = resolve;
    child.on('error', (error) => {
      errors.push(`Spawn failed: ${String(error)}`);
      exited = true;
      resolve();
    });
    child.on('exit', (code, exitSignal) => {
      exited = true;
      exitCode = code;
      signal = exitSignal;
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) =>
    child.on('close', () => {
      exited = true;
      resolveExecution?.();
      resolve();
    })
  );
  const census = async (): Promise<void> => {
    const rootAliveAtDispatch = !exited;
    const dispatchedAt = new Date().toISOString();
    try {
      const rows = await snapshot();
      const root = rows.find((row) => row.pid === child.pid);
      let rootAlive = rootAliveAtDispatch;
      if (
        root &&
        rootIdentity === null &&
        rootAlive &&
        (root.parentPid !== process.pid ||
          (process.platform !== 'win32' && root.group !== child.pid))
      ) {
        snapshotErrors.push(
          `unexpected root origin for PID ${root.pid}: parent ${root.parentPid}, group ${root.group}; expected parent ${process.pid}${process.platform === 'win32' ? '' : ` and group ${child.pid}`}`
        );
        rootAlive = false;
      }
      const scoped = scopeNativeProcesses(rows, {
        rootPid: child.pid ?? -1,
        rootAlive,
        rootIdentity,
        observed,
      });
      rootIdentity = scoped.rootIdentity;
      observed = scoped.observed;
      current = scoped.current;
      if (guardCompilerHelpers) {
        unattributedCompilerHelpers = unattributedNativeCompilerHelpers(before, rows, observed);
        await Bun.write(
          join(options.out, `processes-latest-${options.label}.json`),
          `${JSON.stringify(rows, null, 2)}\n`
        );
      }
      await appendFile(
        join(options.out, `terminal-${options.label}.jsonl`),
        `${JSON.stringify({ at: new Date().toISOString(), dispatchedAt, rootAlive: rootAliveAtDispatch, rootAliveAtCompletion: !exited, processes: current, unattributedCompilerHelpers })}\n`
      );
    } catch (error) {
      snapshotErrors.push(String(error));
    }
  };
  const terminate = async (): Promise<void> => {
    await census();
    if (!exited) child.kill('SIGKILL');
    // One fresh native snapshot bounds cleanup even when a command has many children.
    const latest = await snapshot();
    const identities = new Set(latest.map((row) => row.identity));
    for (const owned of current) {
      try {
        if (identities.has(owned.identity)) process.kill(owned.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          errors.push(`Owned timeout cleanup failed: ${String(error)}`);
      }
    }
  };
  let timeoutCleanup: Promise<void> | null = null;
  const timeout = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    timeoutCleanup = terminate().catch((error) => {
      errors.push(`Timeout cleanup failed: ${String(error)}`);
    });
  }, options.timeoutSeconds * 1_000);
  const monitor = async (): Promise<void> => {
    while (!exited) {
      await census();
      await Promise.race([execution, pause(pollIntervalMs)]);
    }
  };
  await Promise.all([execution, monitor()]);
  clearTimeout(timeout);
  if (timeoutCleanup) await timeoutCleanup;
  let streamsClosed = false;
  await Promise.race([
    closed.then(() => {
      streamsClosed = true;
    }),
    pause(options.settleMs ?? 5_000),
  ]);
  if (!streamsClosed) {
    errors.push('Owned process output pipes did not close after command exit');
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const settleUntil = Date.now() + (options.settleMs ?? 5_000);
  do {
    await census();
    if (!current.length || Date.now() >= settleUntil) break;
    await pause(pollIntervalMs);
  } while (current.length > 0 && Date.now() < settleUntil);
  await Promise.all(
    [combined, rawOut, rawError].map(
      (writer) => new Promise<void>((resolve) => writer.end(resolve))
    )
  );
  const settlement: NativeSettlement = {
    scope: 'observed descendants and command process group',
    pollIntervalMs,
    rootObserved: rootIdentity !== null,
    observed,
    survivors: current,
    snapshotErrors,
    ...(guardCompilerHelpers ? { unattributedCompilerHelpers } : {}),
    empty:
      current.length === 0 &&
      snapshotErrors.length === 0 &&
      unattributedCompilerHelpers.length === 0,
  };
  if (unattributedCompilerHelpers.length) {
    errors.push(
      `Unattributed compiler helpers ${JSON.stringify(unattributedCompilerHelpers)}; expected verified command ownership and empty terminal census`
    );
  }
  return {
    label: options.label,
    command: options.command,
    environment: Object.fromEntries(
      [
        'CI',
        'TURBO_FORCE',
        'MANGOSTUDIO_BUN_TEST_ARGS',
        'MANGOSTUDIO_RUNTIME_BINARY',
        'MANGOSTUDIO_FAKE_CURSOR_AGENT',
        'CARGO_TARGET_DIR',
        'CARGO_BUILD_TARGET',
        'RUSTFLAGS',
        'RUSTDOCFLAGS',
        'CARGO_ENCODED_RUSTFLAGS',
      ].map((key) => [key, options.env[key] ?? null])
    ),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    signal,
    timedOut,
    timeoutSeconds: options.timeoutSeconds,
    errors,
    log,
    settlement,
  };
}
