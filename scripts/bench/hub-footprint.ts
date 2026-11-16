#!/usr/bin/env bun
/**
 * Compares compiled hub binaries: size, time to the first healthy `/api/health`, idle memory
 * and memory after a small request workload. Candidates run in rotated order inside every
 * round, so a slow minute on the host lands on each of them in turn.
 *
 * Every hub gets a fresh isolated home and a fresh database ("cold" in startup.ts terms) and runs
 * without a sibling runtime: the hub's own pages, auth and chat list need none, and the runtime
 * child is a separate process that would not be in the hub's `/proc/<pid>/status` anyway.
 *
 * Memory is read from `/proc/<pid>/status`, Linux only. `RssFile` is the executable image on
 * disk-backed files and `RssShmem` on tmpfs; keep candidates on one filesystem.
 *
 * Example: bun scripts/bench/hub-footprint.ts --rounds 5 --idle-seconds 10 --workload base=./a/mangostudio head=./b/mangostudio
 */
import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fatal, parseArgs } from '../lib/args';
import { rotatedOrder } from '../lib/bench-order';
import { fetchRaw } from '../lib/content-encoding-smoke';
import {
  createIsolatedHubHome,
  guardIsolatedHub,
  isolatedHubEnv,
  ownsServerState,
  removeIsolatedHubHome,
  reserveEphemeralPort,
} from '../lib/hub-process';
import { runHubWorkload, type WorkloadResult } from '../lib/hub-workload';
import { summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';
import { assertBenchmarkPlatform } from './benchmark-platform';

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5;
const SETTLE_AFTER_WORKLOAD_MS = 3_000;

/** Memory fields read from `/proc/<pid>/status`, in kB. */
export interface ProcessMemoryKb {
  readonly VmRSS: number;
  readonly RssAnon: number;
  readonly RssFile: number;
  readonly RssShmem: number;
  readonly VmHWM: number;
}

const MEMORY_FIELDS = ['VmRSS', 'RssAnon', 'RssFile', 'RssShmem', 'VmHWM'] as const;

/**
 * Reads the memory fields out of a `/proc/<pid>/status` document, naming the first one missing.
 * Example: parseProcessStatus('VmRSS:\t  70836 kB\n...') // { VmRSS: 70836, ... }
 */
export function parseProcessStatus(status: string): ProcessMemoryKb {
  const found: Record<string, number> = {};
  for (const field of MEMORY_FIELDS) {
    const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(status);
    if (!match) {
      throw new Error(
        `process status: expected a "${field}: <n> kB" line | received: ${status.slice(0, 200)}`
      );
    }
    found[field] = Number(match[1]);
  }
  return found as unknown as ProcessMemoryKb;
}

/**
 * Parses `label=path` candidate arguments; labels must be unique.
 * Example: parseCandidates(['base=./a', 'head=./b']) // [{ label: 'base', binary: './a' }, ...]
 */
export function parseCandidates(
  values: readonly string[]
): readonly { readonly label: string; readonly binary: string }[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const separator = value.indexOf('=');
    const label = separator > 0 ? value.slice(0, separator) : '';
    const binary = separator > 0 ? value.slice(separator + 1) : '';
    if (!label || !binary) {
      throw new Error(`candidate: expected label=path | received: ${value}`);
    }
    if (seen.has(label)) {
      throw new Error(`candidate: expected unique labels | received: ${label} twice`);
    }
    seen.add(label);
    return { label, binary: resolve(binary) };
  });
}

async function readMemory(pid: number): Promise<ProcessMemoryKb> {
  return parseProcessStatus(await Bun.file(`/proc/${pid}/status`).text());
}

interface Row {
  readonly round: number;
  readonly label: string;
  readonly toHealthMs: number;
  readonly load1: number;
  readonly atHealth: ProcessMemoryKb;
  readonly idle: ProcessMemoryKb | null;
  readonly afterWorkload: ProcessMemoryKb | null;
  /** Memory after this many cumulative identity requests of the largest script, by count. */
  readonly afterIdentityRequests: Readonly<Record<number, ProcessMemoryKb>>;
  readonly workload: WorkloadResult | null;
}

interface RunOptions {
  readonly idleSeconds: number;
  readonly workload: boolean;
  /** Ascending request counts to read memory at; each needs `workload` for the script to fetch. */
  readonly identityCheckpoints: readonly number[];
}

/**
 * Parses `1,10,100` into ascending positive counts. Example: parseCheckpoints('1,10,100') // [1, 10, 100]
 */
export function parseCheckpoints(value: string): readonly number[] {
  const counts = value.split(',').map((part) => Number(part.trim()));
  const ascending = counts.every(
    (count, index) => Number.isSafeInteger(count) && count > 0 && count > (counts[index - 1] ?? 0)
  );
  if (!ascending) {
    throw new Error(
      `--identity-checkpoints: expected ascending positive integers | received: ${value}`
    );
  }
  return counts;
}

async function measureCandidate(
  label: string,
  binary: string,
  round: number,
  options: RunOptions
): Promise<Row> {
  const home = createIsolatedHubHome();
  const port = await reserveEphemeralPort();
  const startedAt = performance.now();
  const spawnedAt = Date.now();
  const child = Bun.spawn([binary, 'serve', String(port)], {
    env: isolatedHubEnv(home, port),
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  // A Ctrl-C must stop the hub's group and delete its home, not leave a listener behind.
  const releaseGuard = guardIsolatedHub(child, home, `footprint hub ${label}`);
  try {
    let toHealthMs: number | null = null;
    while (performance.now() - startedAt < READY_TIMEOUT_MS && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (response.status === 200 && (await ownsServerState(home, child.pid, port, spawnedAt))) {
          toHealthMs = performance.now() - startedAt;
          break;
        }
      } catch {
        // Connection refused while the hub starts.
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    if (toHealthMs === null) {
      throw new Error(
        `${label}: expected HTTP 200 and matching state within ${READY_TIMEOUT_MS} ms | received ${child.exitCode === null ? 'not ready' : `exit ${child.exitCode}`}`
      );
    }
    const atHealth = await readMemory(child.pid);
    let idle: ProcessMemoryKb | null = null;
    let afterWorkload: ProcessMemoryKb | null = null;
    let workload: WorkloadResult | null = null;
    const afterIdentityRequests: Record<number, ProcessMemoryKb> = {};
    if (options.idleSeconds > 0) {
      await Bun.sleep(options.idleSeconds * 1000);
      idle = await readMemory(child.pid);
    }
    if (options.workload) {
      workload = await runHubWorkload(`http://127.0.0.1:${port}`);
      await Bun.sleep(SETTLE_AFTER_WORKLOAD_MS);
      afterWorkload = await readMemory(child.pid);
      let sent = 0;
      for (const checkpoint of options.identityCheckpoints) {
        for (; sent < checkpoint; sent += 1) {
          const response = await fetchRaw(
            `http://127.0.0.1:${port}${workload.assetPath}`,
            'identity'
          );
          if (response.status !== 200) {
            throw new Error(
              `${label}: GET ${workload.assetPath} (identity): expected 200 | received ${response.status}`
            );
          }
        }
        await Bun.sleep(SETTLE_AFTER_WORKLOAD_MS);
        afterIdentityRequests[checkpoint] = await readMemory(child.pid);
      }
    }
    const load1 = Number((await Bun.file('/proc/loadavg').text()).split(' ')[0]);
    return {
      round,
      label,
      toHealthMs,
      load1,
      atHealth,
      idle,
      afterWorkload,
      afterIdentityRequests,
      workload,
    };
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await child.exited;
    }
    releaseGuard();
    removeIsolatedHubHome(home);
  }
}

function median(values: readonly number[]): number {
  return summarizeLatencies(values).median;
}

function printHelp(): never {
  log(`Usage: bun scripts/bench/hub-footprint.ts [--rounds N] [--idle-seconds S] [--workload] [--output file] <label=binary>...

  --rounds N        Rounds; each starts every binary once, in rotated order (default 5)
  --idle-seconds S  Read memory S seconds after the first healthy response (default 0 = skip)
  --workload        Sign in, list chats, fetch / and the largest script as br, gzip and identity;
                    read memory ${SETTLE_AFTER_WORKLOAD_MS / 1000} s later
  --identity-checkpoints 1,10,100
                    After the workload, keep requesting the largest script without compression
                    and read memory ${SETTLE_AFTER_WORKLOAD_MS / 1000} s after each cumulative count (needs --workload)
  --output file     Save every row as JSON
  --help            Show this help message`);
  process.exit(0);
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--workload'],
    valueFlags: ['--rounds', '--idle-seconds', '--identity-checkpoints', '--output'],
  });
  if (flags['--help']) printHelp();
  if (positional.length === 0) fatal('Pass at least one label=binary candidate.');
  if (process.platform !== 'linux') {
    fatal(`hub-footprint: expected Linux procfs | received: ${process.platform}`);
  }
  assertBenchmarkPlatform(process.platform);
  const rounds = Number(values['--rounds'] ?? 5);
  const idleSeconds = Number(values['--idle-seconds'] ?? 0);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    fatal(`--rounds: expected a positive integer | received: ${values['--rounds']}`);
  }
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) {
    fatal(`--idle-seconds: expected a non-negative number | received: ${values['--idle-seconds']}`);
  }
  let identityCheckpoints: readonly number[] = [];
  try {
    if (values['--identity-checkpoints']) {
      identityCheckpoints = parseCheckpoints(values['--identity-checkpoints']);
      if (!flags['--workload'])
        throw new Error('--identity-checkpoints: expected --workload | received: none');
    }
  } catch (caught) {
    fatal(caught instanceof Error ? caught.message : String(caught));
  }
  const candidates = parseCandidates(positional);
  const sizes = new Map<string, number>();
  for (const { label, binary } of candidates) {
    sizes.set(label, (await stat(binary).catch(() => fatal(`No such binary: ${binary}`))).size);
  }

  header('Hub footprint');
  const rows: Row[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const { label, binary } of rotatedOrder(candidates, round)) {
      const row = await measureCandidate(label, binary, round, {
        idleSeconds,
        workload: flags['--workload'] ?? false,
        identityCheckpoints,
      });
      rows.push(row);
      info(
        `  round ${round + 1}/${rounds} ${label}: health ${row.toHealthMs.toFixed(1)} ms, load ${row.load1}`
      );
    }
  }

  const summary = candidates.map(({ label }) => {
    const mine = rows.filter((row) => row.label === label);
    const pick = (read: (row: Row) => number | undefined): number | null => {
      const present = mine.flatMap((row) => read(row) ?? []);
      return present.length ? median(present) : null;
    };
    return {
      label,
      bytes: sizes.get(label),
      toHealthMs: summarizeLatencies(mine.map((row) => row.toHealthMs)),
      idleVmRssKb: pick((row) => row.idle?.VmRSS),
      idleRssAnonKb: pick((row) => row.idle?.RssAnon),
      idleRssFileKb: pick((row) => row.idle?.RssFile),
      idleRssShmemKb: pick((row) => row.idle?.RssShmem),
      afterWorkloadVmRssKb: pick((row) => row.afterWorkload?.VmRSS),
      afterWorkloadRssAnonKb: pick((row) => row.afterWorkload?.RssAnon),
      afterWorkloadVmHwmKb: pick((row) => row.afterWorkload?.VmHWM),
      afterIdentityRequestsVmRssKb: Object.fromEntries(
        identityCheckpoints.map((count) => [
          count,
          pick((row) => row.afterIdentityRequests[count]?.VmRSS),
        ])
      ),
      assetMedianMs: {
        br: pick((row) => row.workload?.assetMedianMs.br),
        gzip: pick((row) => row.workload?.assetMedianMs.gzip),
        identity: pick((row) => row.workload?.assetMedianMs.identity),
      },
    };
  });
  const json = `${JSON.stringify({ bun: Bun.version, rounds, idleSeconds, summary, rows }, null, 2)}\n`;
  if (values['--output']) await writeFile(resolve(values['--output']), json);
  console.log(JSON.stringify({ rounds, idleSeconds, summary }, null, 2));
}

if (import.meta.main) await main();
