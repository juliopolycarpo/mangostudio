#!/usr/bin/env bun

/**
 * Measures `fs.grep` on a real `mangostudio-runtime` child over stdio.
 *
 * The runtime compiles a grep pattern and builds its QuickJS context once per
 * operation, and the cost of that is only visible next to the work it is
 * amortised over. This drives the real binary through the protocol SDK the way
 * the hub does and reports, per scenario:
 *
 *   - `files-1`, `files-100`, `files-1000`: grep elapsed time over that many small files
 *   - `large-file`: elapsed time and throughput over one large file
 *   - `cancel`: latency from aborting a catastrophic match to the peer's answer
 *   - peak resident set size of the child (Linux `VmHWM`; 0 elsewhere)
 *
 * Every sample is a fresh child under a throwaway `MANGO_HOME`, so peak RSS is
 * the scenario's own and no sample warms another. The developer's real
 * `~/.mango` is never read or written. Compare two builds by running the same
 * command against each binary on a quiet machine.
 *
 * Usage:
 *   bun run scripts/bench/grep.ts                        # newest target/ build
 *   bun run scripts/bench/grep.ts <binary> --runs 15
 *   bun run scripts/bench/grep.ts <binary> --scenario files-1000,cancel --json
 *   bun run scripts/bench/grep.ts <binary> --large-mib 64
 *   bun run scripts/bench/grep.ts <binary> --restricted  # capability walk, as under a path policy
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { type LatencySummary, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';

const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const CANCEL_AFTER_MS = 200;
const EXE = process.platform === 'win32' ? '.exe' : '';
const REPO_ROOT = resolve(import.meta.dir, '../..');
const SCENARIOS = ['files-1', 'files-100', 'files-1000', 'large-file', 'cancel'] as const;
type Scenario = (typeof SCENARIOS)[number];

/** Captures and a lookbehind, so the pattern is not a literal a fast path could take. */
const PATTERN = String.raw`(?<=id=)(\d+)-needle$`;
const SMALL_FILE_LINES = 40;
const LARGE_FILLER = 'the quick brown fox jumps over the lazy dog id=12345 and again id=6 needle';
const LARGE_HIT = 'the quick brown fox jumps over the lazy dog id=12345 and again id=6-needle';
/** One hit per block keeps the answer small, so the time is the scan and not the response. */
const LARGE_BLOCK = `${`${LARGE_FILLER}\n`.repeat(4095)}${LARGE_HIT}\n`;

interface Sample {
  /** Request sent until the answer arrived (cancel: abort until the answer), in ms. */
  readonly elapsedMs: number;
  /** Peak resident set size of the child in kB; 0 where unavailable. */
  readonly peakRssKb: number;
  readonly matches: number;
  readonly filesScanned: number;
}

interface Fixture {
  readonly path: string;
  readonly bytes: number;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/grep.ts [binary] [--runs N] [--scenario a,b] [--large-mib N] [--restricted] [--json]

  [binary]         A mangostudio-runtime executable (default: newest of target/release, target/debug)
  --runs N         Measured runs per scenario (default 15)
  --scenario LIST  Comma-separated subset of: ${SCENARIOS.join(', ')}
  --large-mib N    Size of the large-file fixture (default 32)
  --restricted     Send a path policy, as a restricted chat does (capability walk and reads)
  --json           Print only the JSON result
  --help           Show this help message`);
  process.exit(0);
}

async function newestWorkspaceBuild(): Promise<string | undefined> {
  const candidates = ['release', 'debug'].map((profile) =>
    join(REPO_ROOT, 'target', profile, `mangostudio-runtime${EXE}`)
  );
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const path of candidates) {
    const info = await stat(path).catch(() => undefined);
    if (info && (!newest || info.mtimeMs > newest.mtimeMs))
      newest = { path, mtimeMs: info.mtimeMs };
  }
  return newest?.path;
}

async function readPeakRssKb(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    return Number(status.match(/VmHWM:\s+(\d+) kB/)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** `count` small files of `SMALL_FILE_LINES` lines, one in five lines matching. */
async function writeSmallFiles(directory: string, count: number): Promise<Fixture> {
  await mkdir(directory, { recursive: true });
  const lines = Array.from({ length: SMALL_FILE_LINES }, (_, index) =>
    index % 5 === 0 ? `entry id=${index}-needle` : `filler line ${index} without a hit`
  );
  const content = `${lines.join('\n')}\n`;
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(directory, `file-${index}.txt`), content);
  }
  return { path: directory, bytes: Buffer.byteLength(content) * count };
}

async function writeLargeFile(directory: string, mib: number): Promise<Fixture> {
  await mkdir(directory, { recursive: true });
  const target = mib * 2 ** 20;
  const parts: string[] = [];
  let bytes = 0;
  while (bytes < target) {
    parts.push(LARGE_BLOCK);
    bytes += Buffer.byteLength(LARGE_BLOCK);
  }
  const path = join(directory, 'large.txt');
  await writeFile(path, parts.join(''));
  return { path: directory, bytes };
}

/** A line that backtracks catastrophically until the runtime's per-file budget expires. */
async function writeCatastrophicFile(directory: string): Promise<Fixture> {
  await mkdir(directory, { recursive: true });
  const content = `${'a'.repeat(50_000)}b\n`;
  await writeFile(join(directory, 'slow.txt'), content);
  return { path: directory, bytes: Buffer.byteLength(content) };
}

/**
 * `restrictedTo` is the hub's containment shape: with a path policy the runtime
 * walks and reads through directory capabilities (`scan_opened_file`) instead
 * of ambient paths, which is what a restricted chat exercises.
 */
function grepParams(
  fixture: Fixture,
  pattern: string,
  maxFileSizeBytes: number,
  restrictedTo: string | undefined
) {
  return {
    ...(restrictedTo ? { pathPolicy: { allowedRoots: [restrictedTo], deniedRoots: [] } } : {}),
    pattern,
    inputPath: fixture.path,
    resolvedPath: fixture.path,
    caseInsensitive: false,
    maxResults: 10_000_000,
    maxMatchesPerFile: 10_000_000,
    maxFileSizeBytes,
    includeDotfiles: false,
  };
}

/** Spawns a child, handshakes like the hub, and hands the session to `body`. */
async function withRuntime<T>(
  binary: string,
  mangoHome: string,
  body: (session: Session, pid: number) => Promise<T>
): Promise<T> {
  const peer = spawnPort({
    argv: [binary, '--stdio'],
    env: { ...(process.env as Record<string, string>), MANGO_HOME: mangoHome },
  });
  if (peer.pid === undefined) {
    fatal(`could not start ${binary}: ${peer.stderrTail().trim() || 'no pid assigned'}`);
  }
  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    handshakeTimeoutMs: HANDSHAKE_CEILING_MS,
  });
  try {
    await session.ready;
    // Untimed: the first request pays lazy initialisation no grep should be charged for.
    await session.request('runtime.health', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
    return await body(session, peer.pid);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
}

interface GrepResult {
  readonly matches: readonly unknown[];
  readonly filesScanned: number;
}

async function timedGrep(
  session: Session,
  pid: number,
  params: ReturnType<typeof grepParams>
): Promise<Sample> {
  const startedAt = performance.now();
  const result = (await session.request('fs.grep', params, {
    timeoutMs: REQUEST_TIMEOUT_MS,
  })) as GrepResult;
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    peakRssKb: await readPeakRssKb(pid),
    matches: result.matches.length,
    filesScanned: result.filesScanned,
  };
}

async function cancelledGrep(
  session: Session,
  pid: number,
  params: ReturnType<typeof grepParams>
): Promise<Sample> {
  const controller = new AbortController();
  const pending = session
    .request('fs.grep', params, { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal })
    .then(
      () => 'answered' as const,
      () => 'cancelled' as const
    );
  await Bun.sleep(CANCEL_AFTER_MS);
  const abortedAt = performance.now();
  controller.abort();
  const outcome = await pending;
  const elapsedMs = performance.now() - abortedAt;
  if (outcome === 'answered') {
    fatal(
      `expected the catastrophic grep to still be running ${CANCEL_AFTER_MS} ms in | received: an answer before the abort`
    );
  }
  return { elapsedMs, peakRssKb: await readPeakRssKb(pid), matches: 0, filesScanned: 0 };
}

/** Nearest-rank quartiles, so the IQR names measured samples like the summary does. */
function spread(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { p25: round(at(0.25)), p75: round(at(0.75)), iqr: round(at(0.75) - at(0.25)) };
}

function summarize(samples: readonly Sample[], pick: (sample: Sample) => number): LatencySummary {
  return summarizeLatencies(samples.map(pick));
}

async function environmentNotes(binary: string) {
  const cpu = cpus();
  const size = (await stat(binary)).size;
  const version = await Bun.spawn([binary, '--version'], { stdout: 'pipe' }).stdout.text();
  return {
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model.trim() ?? 'unknown'} x${cpu.length}`,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    bun: Bun.version,
    binary,
    binaryBytes: size,
    runtimeVersion: version.trim(),
    pattern: PATTERN,
    restricted,
  };
}

const { flags, values, positional } = parseArgs({
  booleanFlags: ['--json', '--restricted'],
  valueFlags: ['--runs', '--scenario', '--large-mib'],
});
if (flags['--help']) printHelp();

const supplied = positional.shift();
assertNoUnexpectedArguments(positional);
const binary = supplied ? resolve(supplied) : await newestWorkspaceBuild();
if (!binary)
  fatal(
    'No runtime binary. Build one with `cargo build --release -p mangostudio-runtime --locked`.'
  );
if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);

const runs = Number(values['--runs'] ?? 15);
if (!Number.isInteger(runs) || runs < 1) {
  fatal(`\`--runs\` must be a positive integer | received: ${values['--runs']}`);
}
const largeMib = Number(values['--large-mib'] ?? 32);
if (!Number.isInteger(largeMib) || largeMib < 1) {
  fatal(`\`--large-mib\` must be a positive integer | received: ${values['--large-mib']}`);
}
const requested = (values['--scenario'] ?? SCENARIOS.join(',')).split(',');
const unknown = requested.filter((name) => !(SCENARIOS as readonly string[]).includes(name));
if (unknown.length > 0) {
  fatal(`unknown scenario ${unknown.join(', ')} | expected one of: ${SCENARIOS.join(', ')}`);
}
const scenarios = requested as Scenario[];
const quiet = flags['--json'] ?? false;
const restricted = flags['--restricted'] ?? false;

if (!quiet) {
  header('fs.grep benchmark');
  info(`${binary} — ${runs} run(s) per scenario: ${scenarios.join(', ')}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'mango-grep-bench-'));
const results: Record<string, unknown> = {};
try {
  const fixtures: Record<Scenario, () => Promise<Fixture>> = {
    'files-1': () => writeSmallFiles(join(scratch, 'files-1'), 1),
    'files-100': () => writeSmallFiles(join(scratch, 'files-100'), 100),
    'files-1000': () => writeSmallFiles(join(scratch, 'files-1000'), 1000),
    'large-file': () => writeLargeFile(join(scratch, 'large'), largeMib),
    cancel: () => writeCatastrophicFile(join(scratch, 'cancel')),
  };
  for (const scenario of scenarios) {
    const fixture = await fixtures[scenario]();
    const params = grepParams(
      fixture,
      scenario === 'cancel' ? '^(a+)+$' : PATTERN,
      Math.max(fixture.bytes, 1) + 1,
      restricted ? scratch : undefined
    );
    const samples: Sample[] = [];
    for (let run = 0; run < runs; run += 1) {
      const home = join(scratch, `home-${scenario}-${run}`);
      const sample = await withRuntime(binary, home, (session, pid) =>
        scenario === 'cancel'
          ? cancelledGrep(session, pid, params)
          : timedGrep(session, pid, params)
      );
      samples.push(sample);
      if (!quiet) info(`  ${scenario} run ${run + 1}/${runs}: ${sample.elapsedMs.toFixed(1)} ms`);
    }
    const first = samples[0] as Sample;
    const elapsed = summarize(samples, (sample) => sample.elapsedMs);
    results[scenario] = {
      fixtureBytes: fixture.bytes,
      filesScanned: first.filesScanned,
      matches: first.matches,
      elapsedMs: { ...elapsed, ...spread(samples.map((sample) => sample.elapsedMs)) },
      peakRssKb: summarize(samples, (sample) => sample.peakRssKb),
      ...(scenario === 'large-file'
        ? {
            throughputMiBPerS:
              Math.round((fixture.bytes / 2 ** 20 / (elapsed.median / 1000)) * 10) / 10,
          }
        : {}),
      rawElapsedMs: samples.map((sample) => Math.round(sample.elapsedMs * 10) / 10),
    };
  }
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(
  JSON.stringify({ environment: await environmentNotes(binary), runs, scenarios: results }, null, 2)
);
