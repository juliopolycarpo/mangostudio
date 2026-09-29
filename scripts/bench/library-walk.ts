#!/usr/bin/env bun

/**
 * Measures the runtime's library walk: time for one `library.scan` and the
 * child's peak resident memory, on fixtures built to stress the walk.
 *
 * Fixtures (see `library-fixture.ts`):
 *   wide     one instance directory listing far more files than the entry cap
 *   aliases  9 000 distinct leaves plus symlinks onto one file (alias lookups)
 *   dirs     9 000 directories of one file each (visited-directory lookups)
 *   normal   300 ordinary skills (guards against a small-scan regression)
 *
 * Each run spawns a fresh runtime whose `HOME` and `MANGO_HOME` are inside the
 * fixture, so the developer's real `~/.mango` is never read, and its memo is
 * cold. The scan result is hashed so a Base and a Head run prove they answered
 * the same thing. Peak memory is the child's `VmHWM` (Linux only; `null` elsewhere).
 *
 * Usage:
 *   bun run scripts/bench/library-walk.ts generate <scenario> <dir> [--count N] [--links N]
 *   bun run scripts/bench/library-walk.ts scan <binary> <dir> [--runs N]
 *
 * With hyperfine, one process per scan:
 *   hyperfine --warmup 2 --runs 10 'bun run scripts/bench/library-walk.ts scan <binary> <dir> --runs 1'
 */

import { rm } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { summarizeLatencies } from '../lib/latency-stats';
import { info, log } from '../lib/log';
import { materializeFixture, planFixture } from './library-fixture';

const REQUEST_TIMEOUT_MS = 300_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

function printHelp(): never {
  log(`Usage:
  bun run scripts/bench/library-walk.ts generate <scenario> <dir> [--count N] [--links N]
  bun run scripts/bench/library-walk.ts scan <binary> <dir> [--runs N]

  scenario  wide | aliases | dirs | normal
  <dir>     Fixture root: <dir>/home is HOME, <dir>/mango-home is MANGO_HOME (replaced by generate)
  --count   Files (wide, aliases), directories (dirs) or skills (normal)
  --links   Symlinks onto one shared file (aliases; default 50)
  --runs    Scans, each in a fresh runtime (default 10)`);
  process.exit(0);
}

interface ScanSample {
  readonly scanMs: number;
  readonly peakRssMiB: number | null;
  readonly resultSha256: string;
  readonly instances: number;
  readonly invalidReasons: Record<string, number>;
}

/** The child's peak resident set in MiB from `/proc/<pid>/status`, or null off Linux. */
async function peakRssMiB(pid: number): Promise<number | null> {
  const status = await Bun.file(`/proc/${pid}/status`)
    .text()
    .catch(() => '');
  const kib = /^VmHWM:\s+(\d+) kB/m.exec(status)?.[1];
  return kib === undefined ? null : Math.round((Number(kib) / 1024) * 10) / 10;
}

interface ScanEntry {
  readonly instance?: { readonly valid?: boolean; readonly invalidReason?: string };
}

function summarizeScan(result: { entries?: readonly ScanEntry[] }) {
  const invalidReasons: Record<string, number> = {};
  const entries = result.entries ?? [];
  for (const entry of entries) {
    const reason = entry.instance?.invalidReason;
    if (reason) invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
  }
  const digest = new Bun.CryptoHasher('sha256').update(JSON.stringify(result)).digest('hex');
  return { instances: entries.length, invalidReasons, resultSha256: digest };
}

async function scanOnce(binary: string, root: string): Promise<ScanSample> {
  const home = `${root}/home`;
  const peer = spawnPort({
    argv: [binary, '--stdio'],
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      USERPROFILE: home,
      MANGO_HOME: `${root}/mango-home`,
    },
  });
  if (peer.pid === undefined) {
    fatal(`could not start ${binary}: ${peer.stderrTail().trim() || 'no pid assigned'}`);
  }
  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  try {
    await session.ready;
    const startedAt = performance.now();
    const result = await session.request(
      'library.scan',
      { locationSettings: { home: {}, workspace: {} } },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
    const scanMs = performance.now() - startedAt;
    return {
      scanMs,
      peakRssMiB: await peakRssMiB(peer.pid),
      ...summarizeScan(result as { entries?: readonly ScanEntry[] }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
}

async function generate(scenario: string, dir: string, count?: string, links?: string) {
  const options = {
    count: count === undefined ? undefined : Number(count),
    links: links === undefined ? undefined : Number(links),
  };
  const plan = planFixture(scenario, options);
  await rm(dir, { recursive: true, force: true });
  await materializeFixture(plan, `${dir}/home`);
  info(`${scenario}: ${plan.length} entries under ${dir}/home`);
}

async function scan(binary: string, dir: string, runsValue: string | undefined) {
  const runs = Number(runsValue ?? 10);
  if (!Number.isInteger(runs) || runs < 1) {
    fatal(`\`--runs\` must be a positive integer | received: ${runsValue}`);
  }
  if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);
  const samples: ScanSample[] = [];
  for (let run = 0; run < runs; run += 1) samples.push(await scanOnce(binary, dir));
  const hashes = new Set(samples.map((sample) => sample.resultSha256));
  const rss = samples.map((sample) => sample.peakRssMiB);
  const cpu = cpus();
  console.log(
    JSON.stringify(
      {
        environment: {
          os: `${platform()} ${release()} ${arch()}`,
          cpu: `${cpu[0]?.model.trim() ?? 'unknown'} x${cpu.length}`,
          memoryGiB: Math.round(totalmem() / 2 ** 30),
          binary,
        },
        runs,
        scanMs: summarizeLatencies(samples.map((sample) => sample.scanMs)),
        peakRssMiB: rss.every((value) => value !== null)
          ? summarizeLatencies(rss as number[])
          : null,
        instances: samples[0]?.instances,
        invalidReasons: samples[0]?.invalidReasons,
        resultSha256: hashes.size === 1 ? [...hashes][0] : [...hashes],
      },
      null,
      2
    )
  );
}

const { values, positional, flags } = parseArgs({
  valueFlags: ['--count', '--links', '--runs'],
});
if (flags['--help']) printHelp();

const [mode, first, second] = positional;
try {
  if (mode === 'generate' && first && second) {
    assertNoUnexpectedArguments(positional.slice(3));
    await generate(first, resolve(second), values['--count'], values['--links']);
  } else if (mode === 'scan' && first && second) {
    assertNoUnexpectedArguments(positional.slice(3));
    await scan(resolve(first), resolve(second), values['--runs']);
  } else {
    fatal(
      `expected \`generate <scenario> <dir>\` or \`scan <binary> <dir>\` | received: ${positional.join(' ') || '(nothing)'}`
    );
  }
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}
