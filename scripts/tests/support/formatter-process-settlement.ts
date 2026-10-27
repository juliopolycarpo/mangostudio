import { readFile } from 'node:fs/promises';

import {
  type NativeProcess,
  parseNativeProcesses,
  readLinuxProcessIdentity,
} from '../../lib/native-bun-qualification-process';
import { HEARTBEAT_MS } from './fake-rustfmt-markers';
import { isAlive } from './process-liveness';

export interface NativeFormatterProcess extends NativeProcess {
  readonly state: string;
}

interface NativeQueryResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Native query seams; tests supply named query fakes without signaling PIDs. */
export interface FormatterNativeQueries {
  readonly platform: NodeJS.Platform;
  readStat(pid: number, timeoutMs: number): Promise<string | undefined>;
  query(pid: number, timeoutMs: number): Promise<NativeQueryResult>;
}

const NATIVE_QUERIES: FormatterNativeQueries = {
  platform: process.platform,
  async readStat(pid, timeoutMs) {
    try {
      return await readFile(`/proc/${pid}/stat`, {
        encoding: 'utf8',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined;
      throw error;
    }
  },
  async query(pid, timeoutMs) {
    const proc = Bun.spawn(
      ['ps', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args='],
      {
        env: { ...process.env, LC_ALL: 'C' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  },
};

function checkedNativeFormatter(identity: NativeProcess, state: string): NativeFormatterProcess {
  if (
    !Number.isSafeInteger(identity.parentPid) ||
    identity.parentPid < 0 ||
    !Number.isSafeInteger(identity.group) ||
    identity.group === null ||
    identity.group < 0
  ) {
    throw new Error(
      `formatter ${identity.pid}: expected native integer parent/group | received parent ${String(identity.parentPid)}, group ${String(identity.group)}`
    );
  }
  isAlive(identity.pid, function capturedState() {
    return state;
  });
  return { ...identity, state };
}

/**
 * Read one native birth identity and state; absence is distinct from unreadable data.
 * @example const formatter = await readNativeFormatterProcess(marker.pid);
 */
export async function readNativeFormatterProcess(
  pid: number,
  timeoutMs = HEARTBEAT_MS * 6,
  queries: FormatterNativeQueries = NATIVE_QUERIES
): Promise<NativeFormatterProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`formatter PID ${String(pid)}: expected a positive safe integer`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HEARTBEAT_MS * 6) {
    throw new Error(
      `formatter timeout ${String(timeoutMs)}: expected an integer from 1 to ${HEARTBEAT_MS * 6}ms`
    );
  }
  if (queries.platform === 'win32') {
    throw new Error('formatter native identity: expected POSIX; received win32');
  }
  if (queries.platform === 'linux') {
    const stat = await queries.readStat(pid, timeoutMs);
    if (stat === undefined) return undefined;
    const identity = await readLinuxProcessIdentity(
      { pid, parentPid: 0, group: null, identity: '', command: '' },
      function readCapturedStat() {
        return Promise.resolve(stat);
      }
    );
    if (!identity) throw new Error(`formatter ${pid}: expected the captured native birth identity`);
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '';
    return checkedNativeFormatter(identity, state);
  }

  const result = await queries.query(pid, timeoutMs);
  if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
  const match = /^(\s*\d+\s+\d+\s+\d+)\s+(\S+)\s+(.+)$/.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match) {
    throw new Error(
      `formatter ${pid}: expected native PID/parent/group/state/birth | received: ${JSON.stringify(result)}`
    );
  }
  const identity = parseNativeProcesses(`${match[1]} ${match[3]}`, queries.platform)[0];
  if (identity?.pid !== pid) {
    throw new Error(
      `formatter ${pid}: expected its own native identity | received: ${JSON.stringify(identity)}`
    );
  }
  const birth = identity.identity.slice(String(pid).length + 1);
  if (!Number.isFinite(Date.parse(birth)))
    throw new Error(
      `formatter ${pid}: expected a native creation time | received ${JSON.stringify(birth)}`
    );
  const state = match[2]?.slice(0, 1) ?? '';
  return checkedNativeFormatter(identity, state);
}

export interface OwnedFormatterProcess {
  readonly who: string;
  readonly native: NativeFormatterProcess;
}

export interface FormatterSettlementHost {
  read(pid: number, timeoutMs: number): Promise<NativeFormatterProcess | undefined>;
  now(): number;
  pause(ms: number): Promise<void>;
}

const SETTLEMENT_HOST: FormatterSettlementHost = {
  read: readNativeFormatterProcess,
  now: () => performance.now(),
  pause: (ms) => Bun.sleep(ms),
};

/**
 * Require native settlement within the old 300ms observation budget, independent of file writes.
 * @example await waitForFormatterSettlement(ownedBeforeCancellation);
 */
export async function waitForFormatterSettlement(
  owned: readonly OwnedFormatterProcess[],
  host: FormatterSettlementHost = SETTLEMENT_HOST
): Promise<void> {
  if (!owned.length) return;
  const budget = HEARTBEAT_MS * 6;
  const started = host.now();
  const deadline = started + budget;
  let lastLive: Array<{ who: string; current: NativeFormatterProcess }> = [];
  let lastObservedMs: number | undefined;
  while (true) {
    const admittedAt = host.now();
    if (admittedAt >= deadline) {
      if (lastObservedMs === undefined)
        throw new Error(
          `formatter cancellation: expected native observation before the ${budget}ms deadline | received: no in-budget observation`
        );
      throw new Error(
        `formatter cancellation: expected live owned processes: 0 within ${budget}ms | received last native observation: ${JSON.stringify({ elapsedMs: lastObservedMs, live: lastLive })}`
      );
    }
    if (Math.floor(deadline - admittedAt) < 1) {
      await host.pause(deadline - admittedAt);
      continue;
    }
    const attempts: Array<{ pid: number; budgetMs: number }> = [];
    const reads = await Promise.allSettled(
      owned.map(async (expected, index) => {
        const budgetMs = Math.max(0, Math.floor(deadline - host.now()));
        attempts[index] = { pid: expected.native.pid, budgetMs };
        if (budgetMs < 1)
          throw new Error(
            `formatter ${expected.native.pid}: expected query admission before the ${budget}ms deadline`
          );
        return { expected, current: await host.read(expected.native.pid, budgetMs) };
      })
    );
    const completedAt = host.now();
    const failures = reads.flatMap((read) => (read.status === 'rejected' ? [read.reason] : []));
    if (failures.length) {
      const details = reads.flatMap((read, index) =>
        read.status === 'rejected'
          ? [
              {
                ...attempts[index],
                elapsedMs: completedAt - started,
                reason:
                  read.reason instanceof Error
                    ? { name: read.reason.name, message: read.reason.message }
                    : { name: typeof read.reason, message: String(read.reason) },
              },
            ]
          : []
      );
      throw new AggregateError(
        failures,
        `formatter native observation failed | received: ${JSON.stringify(details)}`,
        { cause: failures[0] }
      );
    }
    if (completedAt > deadline) {
      throw new Error(
        `formatter cancellation: expected native observation completion within ${budget}ms | received: ${completedAt - started}ms for PIDs ${owned.map(({ native }) => native.pid).join(', ')}`
      );
    }
    const live = reads.flatMap((read) => {
      if (read.status !== 'fulfilled') return [];
      const { expected, current } = read.value;
      if (!current) return [];
      const running = isAlive(current.pid, function observedState() {
        return current.state;
      });
      return running && current.identity === expected.native.identity
        ? [{ who: expected.who, current }]
        : [];
    });
    if (!live.length) return;
    lastLive = live;
    lastObservedMs = completedAt - started;
    await host.pause(Math.min(10, Math.max(0, deadline - host.now())));
  }
}
