#!/usr/bin/env bun
/**
 * Compares opt-in Rust tests around the actual owned boundary functions.
 * Build both libtest binaries with MANGOSTUDIO_BENCH_SOURCE_SHA set to their
 * source commit, then run fresh Base/Head processes in alternating order.
 *
 * @example
 * bun scripts/bench/external-agent-boundary.ts --base-binary /path/base \
 *   --head-binary /path/head --base-sha BASE --head-sha HEAD --output receipt.json
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoUnexpectedArguments, parseArgs } from '../lib/args';
import { nearestRank } from '../lib/latency-stats';

const PREFIX = 'EXTERNAL_AGENT_BOUNDARY_SAMPLE ';
const REPO_ROOT = resolve(import.meta.dir, '../..');
const TURNS = 'external_agents::turns::benchmarks';
const EVENTS = 'external_agents::adapter::map_events::benchmarks';
export const BOUNDARY_CASES = [
  ...['fingerprint', 'request'].flatMap((operation) =>
    ['ordinary', 'ascii', 'control', 'images', 'combined'].map(
      (fixture) => `${TURNS}::${operation}_${fixture}`
    )
  ),
  ...[
    'text_4096',
    'text_1048576',
    'reasoning_4096',
    'reasoning_1048576',
    'text_4096_slack',
    'reasoning_1048576_slack',
  ].map((fixture) => `${EVENTS}::${fixture}`),
  `${TURNS}::json_size_large_event`,
  `${EVENTS}::bounded_text`,
  `${EVENTS}::remote_error`,
] as const;

export interface BoundarySample {
  readonly case: string;
  readonly operation:
    | 'fingerprint'
    | 'request'
    | 'event'
    | 'json-size'
    | 're-bound'
    | 'remote-error';
  readonly sourceSha: string;
  readonly iterations: number;
  readonly elapsedNs: number;
  readonly inputBytes: number;
  readonly encodedAttachmentBytes: number;
  readonly decodedAttachmentBytes: number;
  readonly attachmentCount: number;
  readonly serializedBytes: number;
  readonly sourceCapacity?: number;
}

/**
 * Reads one measured libtest receipt, rejecting missing or malformed samples.
 * @example parseBoundarySample(stdout, '0123456789abcdef0123456789abcdef01234567');
 */
export function parseBoundarySample(stdout: string, expectedSha: string): BoundarySample {
  const lines = stdout.split('\n').filter((line) => line.includes(PREFIX));
  if (lines.length !== 1)
    throw new Error(`Expected exactly one benchmark receipt; received ${lines.length}.`);
  const line = lines[0] as string;
  const value: unknown = JSON.parse(line.slice(line.indexOf(PREFIX) + PREFIX.length));
  if (!value || typeof value !== 'object')
    throw new Error(`Expected a benchmark object; received ${JSON.stringify(value)}.`);
  const sample = value as Record<string, unknown>;
  for (const key of [
    'iterations',
    'elapsedNs',
    'inputBytes',
    'encodedAttachmentBytes',
    'decodedAttachmentBytes',
    'attachmentCount',
    'serializedBytes',
  ]) {
    const number = sample[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
      throw new Error(`Expected a non-negative safe integer ${key}; received ${String(number)}.`);
  }
  if (sample.iterations === 0) throw new Error('Expected a positive iteration count; received 0.');
  if (
    typeof sample.case !== 'string' ||
    !['fingerprint', 'request', 'event', 'json-size', 're-bound', 'remote-error'].includes(
      String(sample.operation)
    ) ||
    sample.sourceSha !== expectedSha
  )
    throw new Error(
      `Expected a named boundary sample compiled from ${expectedSha}; received ${JSON.stringify(sample)}.`
    );
  if (
    sample.sourceCapacity !== undefined &&
    (typeof sample.sourceCapacity !== 'number' ||
      !Number.isSafeInteger(sample.sourceCapacity) ||
      sample.sourceCapacity < Number(sample.inputBytes))
  )
    throw new Error(
      `Expected sourceCapacity >= inputBytes; received ${String(sample.sourceCapacity)}.`
    );
  return sample as unknown as BoundarySample;
}

/**
 * Summarizes unrounded per-operation timings and independently available RSS.
 * @example summarizeBoundarySamples([{ ns: 100, peakRssKiB: null }]);
 */
export function summarizeBoundarySamples(
  samples: readonly { ns: number; peakRssKiB: number | null }[]
) {
  if (
    samples.length === 0 ||
    samples.some(
      (sample) =>
        !Number.isFinite(sample.ns) ||
        sample.ns < 0 ||
        (sample.peakRssKiB !== null &&
          (!Number.isFinite(sample.peakRssKiB) || sample.peakRssKiB <= 0))
    )
  )
    throw new Error(
      `Expected measured timings and positive RSS or null; received ${JSON.stringify(samples)}.`
    );
  const timings = samples.map((sample) => sample.ns).sort((left, right) => left - right);
  const memory = samples
    .flatMap((sample) => (sample.peakRssKiB === null ? [] : [sample.peakRssKiB]))
    .sort((left, right) => left - right);
  return {
    count: samples.length,
    medianNs: median(timings),
    p95Ns: nearestRank(timings, 0.95),
    minNs: timings[0] as number,
    maxNs: timings.at(-1) as number,
    rssSamples: memory.length,
    medianPeakRssKiB: memory.length === 0 ? null : median(memory),
    p95PeakRssKiB: memory.length === 0 ? null : nearestRank(memory, 0.95),
  };
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

async function capture(argv: string[], cwd = REPO_ROOT): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv.join(' ')} exited ${code}; expected 0.\n${stderr}\n${stdout}`);
  return stdout;
}

async function runSample(binary: string, sourceSha: string, test: string, rssPath: string) {
  const measureRss = process.platform === 'linux' && (await Bun.file('/usr/bin/time').exists());
  const argv = [binary, test, '--exact', '--ignored', '--nocapture', '--test-threads=1'];
  const stdout = await capture(
    measureRss ? ['/usr/bin/time', '-f', '%M', '-o', rssPath, ...argv] : argv
  );
  const sample = parseBoundarySample(stdout, sourceSha);
  const measuredRss = measureRss ? Number((await readFile(rssPath, 'utf8')).trim()) : NaN;
  const peakRssKiB = Number.isSafeInteger(measuredRss) && measuredRss > 0 ? measuredRss : null;
  return { ...sample, test, ns: sample.elapsedNs / sample.iterations, peakRssKiB };
}

async function binaryMetadata(binary: string, sourceSha: string) {
  const bytes = await Bun.file(binary).arrayBuffer();
  const lock = await capture(['git', 'show', `${sourceSha}:Cargo.lock`]);
  return {
    binary,
    sourceSha,
    binarySha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    lockSha256: new Bun.CryptoHasher('sha256').update(lock).digest('hex'),
  };
}

async function main() {
  const { values, positional } = parseArgs({
    valueFlags: [
      '--base-binary',
      '--head-binary',
      '--base-sha',
      '--head-sha',
      '--output',
      '--samples',
      '--profile',
      '--case',
    ],
  });
  assertNoUnexpectedArguments(positional);
  const base = values['--base-binary'];
  const head = values['--head-binary'];
  const baseSha = values['--base-sha'];
  const headSha = values['--head-sha'];
  const output = values['--output'];
  const samples = Number(values['--samples'] ?? 30);
  if (
    !base ||
    !head ||
    !baseSha ||
    !headSha ||
    !output ||
    !Number.isInteger(samples) ||
    samples < 1
  )
    throw new Error(
      `Expected --base-binary, --head-binary, --base-sha, --head-sha, --output and positive --samples; received ${JSON.stringify(values)}.`
    );
  const tests = values['--case']
    ? BOUNDARY_CASES.filter((test) => test.endsWith(`::${values['--case']}`))
    : BOUNDARY_CASES;
  if (tests.length === 0)
    throw new Error(`Expected a registered --case; received ${values['--case']}.`);
  const temp = await mkdtemp(join(tmpdir(), 'mango-boundary-bench-'));
  const raw: Awaited<ReturnType<typeof runSample>>[] = [];
  try {
    for (const test of tests) {
      for (let index = 0; index < samples; index++) {
        const order =
          index % 2 === 0
            ? [
                [base, baseSha],
                [head, headSha],
              ]
            : [
                [head, headSha],
                [base, baseSha],
              ];
        for (const [binary, sha] of order)
          raw.push(
            await runSample(resolve(binary as string), sha as string, test, join(temp, 'rss.txt'))
          );
      }
    }
    const summaries = tests.map((test) => ({
      test,
      base: summarizeBoundarySamples(
        raw.filter((sample) => sample.test === test && sample.sourceSha === baseSha)
      ),
      head: summarizeBoundarySamples(
        raw.filter((sample) => sample.test === test && sample.sourceSha === headSha)
      ),
    }));
    const receipt = {
      base: await binaryMetadata(resolve(base), baseSha),
      head: await binaryMetadata(resolve(head), headSha),
      environment: {
        os: `${platform()} ${release()} ${arch()}`,
        cpu: cpus()[0]?.model ?? null,
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        bun: Bun.version,
        rustc: (await capture(['rustc', '-Vv'])).trim(),
        profile: values['--profile'] ?? 'release',
        sampledAt: new Date().toISOString(),
        order: 'fresh processes, alternating Base/Head first in each pair',
        memory:
          process.platform === 'linux'
            ? 'GNU time process high-water RSS, including untimed fixtures'
            : 'unsupported; null',
      },
      summaries,
      raw,
    };
    await mkdir(dirname(resolve(output)), { recursive: true });
    await Bun.write(output, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(
      JSON.stringify({ output: resolve(output), samples: raw.length, summaries }, null, 2)
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
