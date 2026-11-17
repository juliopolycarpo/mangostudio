#!/usr/bin/env bun

/**
 * Measures runtime request paths that `grep.ts` does not reach: `fs.glob`
 * (glob compilation and matching over a large tree, and a large file list as
 * the answer) and the protocol round trip (frame encode and decode, params and
 * result validation) with small requests and a multi-MiB `fs.write-file` params.
 * Large results (`fs.list-directory`, `fs.read-file`) are `runtime-results.ts`.
 *
 * Each measured run starts a fresh runtime child per binary, makes one untimed
 * request so lazy initialisation is not charged, then times a fixed batch of
 * requests over one session. Binaries are interleaved run by run in a rotating
 * order (ABBA for two). With exactly two binaries the result also carries a
 * paired comparison: the second binary's time minus the first's, per run.
 *
 * Usage:
 *   bun run scripts/bench/runtime-requests.ts base=<old-binary> head=<new-binary> --runs 31 --warmup 3
 *   bun run scripts/bench/runtime-requests.ts <binary> --scenario glob-patterns,rpc-small --json
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { fatal, parseArgs } from '../lib/args';
import { rotatedOrder } from '../lib/bench-order';
import { pairedComparison, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';
import { buildProfileOf, newestWorkspaceBuild } from './runtime-binary';

const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MIB = 2 ** 20;

export const REQUEST_SCENARIOS = [
  'glob-patterns',
  'glob-large-list',
  'rpc-small',
  'rpc-small-read',
  'rpc-large-params',
] as const;
export type RequestScenario = (typeof REQUEST_SCENARIOS)[number];

/** Patterns `fs.glob` compiles and matches against every entry of the pattern tree. */
export const GLOB_PATTERNS: readonly string[] = [
  '**/*.ts',
  '**/*.{ts,tsx}',
  '**/*.{md,json,rs}',
  'pkg-3/**/*.ts',
  'pkg-1?/src/**/*.tsx',
  'pkg-*/test/*.spec.ts',
  '**/mod-[0-4]/file-1*.ts',
  '**/file-?.md',
  'pkg-7/src/mod-5/*',
  '*/src/*/file-42.*',
  '**/test/**',
  '!pkg-1/**/*.ts',
  '**/*.{ts,tsx,md,json,rs}',
  'pkg-0/**',
  '**/*.js',
  '**/mod-9/*.rs',
];

const EXTENSIONS = ['ts', 'tsx', 'md', 'json', 'rs'] as const;

/**
 * Relative paths of a `packages × modules × filesPerModule` tree:
 * `pkg-P/src/mod-M/file-K.ext`, with every tenth module's files also mirrored
 * under `pkg-P/test/` as `.spec.ts`, so patterns have both shapes to match.
 */
export function treePaths(packages: number, modules: number, filesPerModule: number): string[] {
  const paths: string[] = [];
  for (let pkg = 0; pkg < packages; pkg += 1) {
    for (let module = 0; module < modules; module += 1) {
      for (let file = 0; file < filesPerModule; file += 1) {
        const extension = EXTENSIONS[(pkg + module + file) % EXTENSIONS.length];
        paths.push(`pkg-${pkg}/src/mod-${module}/file-${file}.${extension}`);
      }
      if (module % 10 === 0) paths.push(`pkg-${pkg}/test/mod-${module}.spec.ts`);
    }
  }
  return paths;
}

async function writeTree(root: string, paths: readonly string[]): Promise<void> {
  const made = new Set<string>();
  for (const path of paths) {
    const directory = dirname(join(root, path));
    if (!made.has(directory)) {
      await mkdir(directory, { recursive: true });
      made.add(directory);
    }
    await writeFile(join(root, path), '');
  }
}

/** UTF-8 text of about `bytes` bytes in 80-column lines, a valid `fs.read-file` text body. */
export function textOfSize(bytes: number): string {
  const line = `${'0123456789abcdef'.repeat(5)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

/** What one scenario needs to issue its timed batch, and how to check each answer. */
interface Workload {
  readonly callsPerSample: number;
  /** Issues the timed calls; throws if an answer is not the shape the scenario expects. */
  readonly runBatch: (session: Session) => Promise<void>;
  /** Untimed work after each batch, such as removing files the batch wrote. */
  readonly cleanup?: () => Promise<void>;
}

let nextWriteId = 0;

function request(session: Session, method: string, params: unknown): Promise<unknown> {
  return session.request(method as never, params as never, {
    timeoutMs: REQUEST_TIMEOUT_MS,
  }) as Promise<unknown>;
}

function expectField(
  value: unknown,
  field: string,
  check: (field: unknown) => boolean,
  what: string
) {
  const found = (value as Record<string, unknown> | null)?.[field];
  if (!check(found)) {
    throw new Error(
      `expected ${what} | received ${field}: ${JSON.stringify(found)?.slice(0, 120)}`
    );
  }
}

/**
 * Builds the workload for `scenario` over fixtures under `scratch`. The fixture
 * is written once and shared by every binary and run.
 */
export async function prepareWorkload(
  scenario: RequestScenario,
  scratch: string,
  sizes: {
    readonly patternFiles: number;
    readonly listFiles: number;
    readonly payloadMiB: number;
  }
): Promise<Workload> {
  switch (scenario) {
    case 'glob-patterns': {
      const root = join(scratch, 'pattern-tree');
      await writeTree(root, treePaths(20, 10, sizes.patternFiles / 200));
      return {
        callsPerSample: GLOB_PATTERNS.length,
        runBatch: async (session) => {
          for (const pattern of GLOB_PATTERNS) {
            const result = await request(session, 'fs.glob', globParams(root, pattern));
            expectField(result, 'matches', Array.isArray, 'a matches array');
          }
        },
      };
    }
    case 'glob-large-list': {
      const root = join(scratch, 'list-tree');
      await writeTree(root, treePaths(50, 20, sizes.listFiles / 1000));
      return {
        callsPerSample: 1,
        runBatch: async (session) => {
          const result = await request(session, 'fs.glob', globParams(root, '**/*'));
          expectField(
            result,
            'matches',
            (matches) => Array.isArray(matches) && matches.length >= sizes.listFiles,
            `at least ${sizes.listFiles} matches`
          );
          expectField(result, 'truncated', (flag) => flag === false, 'truncated false');
        },
      };
    }
    case 'rpc-small':
      return {
        callsPerSample: 2_000,
        runBatch: async (session) => {
          for (let call = 0; call < 2_000; call += 1) {
            await request(session, 'runtime.health', {});
          }
        },
      };
    case 'rpc-small-read': {
      const path = join(scratch, 'small.txt');
      await writeFile(path, textOfSize(1_024));
      return {
        callsPerSample: 1_000,
        runBatch: async (session) => {
          for (let call = 0; call < 1_000; call += 1) {
            const result = await request(session, 'fs.read-file', readParams(path, 1_000));
            expectField(result, 'content', (text) => typeof text === 'string', 'a content string');
          }
        },
      };
    }
    case 'rpc-large-params': {
      const content = textOfSize(sizes.payloadMiB * MIB);
      // The runtime refuses to overwrite a file it has not read, so every call
      // writes a path no earlier call or run created; `cleanup` removes them untimed.
      let written: string[] = [];
      return {
        callsPerSample: 5,
        cleanup: async () => {
          await Promise.all(written.map((path) => rm(path, { force: true })));
          written = [];
        },
        runBatch: async (session) => {
          for (let call = 0; call < 5; call += 1) {
            const path = join(scratch, `large-write-${nextWriteId}.txt`);
            nextWriteId += 1;
            written.push(path);
            const result = await request(session, 'fs.write-file', {
              chatId: 'bench-chat',
              captureSnapshot: false,
              inputPath: path,
              resolvedPath: path,
              content,
            });
            expectField(
              (result as { result?: unknown } | null)?.result ?? result,
              'bytesWritten',
              (written) => written === Buffer.byteLength(content),
              `bytesWritten ${Buffer.byteLength(content)}`
            );
          }
        },
      };
    }
  }
}

function globParams(cwd: string, pattern: string) {
  return {
    pattern,
    cwd,
    maxResults: 1_000_000,
    includeDotfiles: false,
    absolute: false,
  };
}

function readParams(resolvedPath: string, maxLines: number) {
  return {
    chatId: 'bench-chat',
    inputPath: resolvedPath,
    resolvedPath,
    startLine: 1,
    maxLines,
  };
}

/** Spawns a child, handshakes like the hub, and runs one untimed request before `body`. */
async function withRuntime<T>(
  binary: string,
  mangoHome: string,
  body: (session: Session) => Promise<T>
): Promise<T> {
  const peer = spawnPort({
    argv: [binary, '--stdio'],
    env: { ...(process.env as Record<string, string>), MANGO_HOME: mangoHome },
  });
  if (peer.pid === undefined) {
    throw new Error(`could not start ${binary}: ${peer.stderrTail().trim() || 'no pid assigned'}`);
  }
  const session = new Session(peer.port, {
    peer: { name: 'mangostudio-bench', version: 'bench', role: 'hub' },
    capabilities: {
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
    },
    handshakeTimeoutMs: HANDSHAKE_CEILING_MS,
  });
  try {
    await session.ready;
    await request(session, 'runtime.health', {});
    return await body(session);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
}

interface Candidate {
  readonly label: string;
  readonly binary: string;
}

/** `label=path` or a bare path (labelled `binary`). */
export function parseCandidate(argument: string): Candidate {
  const separator = argument.indexOf('=');
  if (separator <= 0) return { label: 'binary', binary: resolve(argument) };
  return {
    label: argument.slice(0, separator),
    binary: resolve(argument.slice(separator + 1)),
  };
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/runtime-requests.ts [[label=]binary ...] [--runs N] [--warmup N] [--scenario a,b] [--payload-mib N] [--json]

  [label=]binary   mangostudio-runtime executables, interleaved run by run (ABBA for two)
  --runs N         Measured runs per scenario (default 15)
  --warmup N       Untimed runs per binary before measuring (default 0)
  --scenario LIST  Comma-separated subset of: ${REQUEST_SCENARIOS.join(', ')}
  --payload-mib N  Size of the rpc-large-params payload (default 8, at most 9)
  --json           Print only the JSON result
  --help           Show this help message`);
  process.exit(0);
}

async function main() {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--json'],
    valueFlags: ['--runs', '--warmup', '--scenario', '--payload-mib'],
  });
  if (flags['--help']) printHelp();
  const candidates = positional.map(parseCandidate);
  if (candidates.length === 0) {
    const newest = await newestWorkspaceBuild(resolve(import.meta.dir, '../..'));
    if (!newest)
      fatal(
        'No runtime binary. Build one with `cargo build --release -p mangostudio-runtime --locked`.'
      );
    candidates.push({ label: 'binary', binary: newest });
  }
  const runs = Number(values['--runs'] ?? 15);
  const warmup = Number(values['--warmup'] ?? 0);
  const payloadMiB = Number(values['--payload-mib'] ?? 8);
  if (!Number.isInteger(runs) || runs < 1)
    fatal(`\`--runs\` must be a positive integer | received: ${values['--runs']}`);
  if (!Number.isInteger(warmup) || warmup < 0)
    fatal(`\`--warmup\` must be a non-negative integer | received: ${values['--warmup']}`);
  // The runtime refuses text above 10 MiB, so a larger payload would measure an error.
  if (!Number.isInteger(payloadMiB) || payloadMiB < 1 || payloadMiB > 9) {
    fatal(
      `\`--payload-mib\` must be an integer from 1 to 9 | received: ${values['--payload-mib']}`
    );
  }
  const requested = (values['--scenario'] ?? REQUEST_SCENARIOS.join(',')).split(',');
  const scenarios = requested.filter((name): name is RequestScenario =>
    (REQUEST_SCENARIOS as readonly string[]).includes(name)
  );
  if (scenarios.length !== requested.length) {
    fatal(
      `\`--scenario\` must name scenarios from ${REQUEST_SCENARIOS.join(', ')} | received: ${requested.join(',')}`
    );
  }
  const quiet = flags['--json'] ?? false;
  if (!quiet) {
    header('runtime request benchmark');
    info(
      `${candidates.map(({ label, binary }) => `${label}=${binary} (${buildProfileOf(binary)})`).join(' vs ')} - ${runs} run(s) per scenario (after ${warmup} warm-up): ${scenarios.join(', ')}`
    );
  }

  const scratch = await mkdtemp(join(tmpdir(), 'mango-requests-bench-'));
  const results: Record<string, unknown> = {};
  try {
    for (const scenario of scenarios) {
      const workload = await prepareWorkload(scenario, scratch, {
        patternFiles: 20_000,
        listFiles: 50_000,
        payloadMiB,
      });
      const samples = new Map<string, number[]>(candidates.map(({ label }) => [label, []]));
      const loadBefore = loadavg()[0] ?? 0;
      for (let run = -warmup; run < runs; run += 1) {
        for (const { label, binary } of rotatedOrder(candidates, run)) {
          const home = join(scratch, `home-${scenario}-${label}-${run + warmup}`);
          const elapsedMs = await withRuntime(binary, home, async (session) => {
            const startedAt = performance.now();
            await workload.runBatch(session);
            const elapsed = performance.now() - startedAt;
            await workload.cleanup?.();
            return elapsed;
          });
          if (run < 0) continue;
          samples.get(label)?.push(elapsedMs);
          if (!quiet)
            info(`  ${scenario} ${label} run ${run + 1}/${runs}: ${elapsedMs.toFixed(1)} ms`);
        }
      }
      const perBinary: Record<string, unknown> = {};
      for (const [label, own] of samples) {
        perBinary[label] = {
          batchMs: summarizeLatencies(own),
          rawBatchMs: own.map((value) => Math.round(value * 100) / 100),
        };
      }
      const labels = [...samples.keys()];
      const [first, second] = labels.map((label) => samples.get(label) as number[]);
      results[scenario] = {
        callsPerSample: workload.callsPerSample,
        loadAverage1mBefore: loadBefore,
        loadAverage1mAfter: loadavg()[0] ?? 0,
        binaries: perBinary,
        ...(labels.length === 2 && first && second
          ? {
              pairedMs: {
                baseline: labels[0],
                candidate: labels[1],
                ...pairedComparison(first, second),
              },
            }
          : {}),
      };
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const cpu = cpus();
  console.log(
    JSON.stringify(
      {
        environment: {
          os: `${platform()} ${release()} ${arch()}`,
          cpu: `${cpu[0]?.model.trim() ?? 'unknown'} x${cpu.length}`,
          memoryGiB: Math.round(totalmem() / 2 ** 30),
          bun: Bun.version,
          binaries: candidates,
          order: 'rotated every run: ABBA for two candidates',
        },
        runs,
        warmup,
        scenarios: results,
      },
      null,
      2
    )
  );
}

if (import.meta.main) await main();
