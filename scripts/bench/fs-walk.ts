#!/usr/bin/env bun

/**
 * Measures `fs.glob` and `fs.grep` over one tree on a real `mangostudio-runtime` child, with and
 * without a path policy.
 *
 * A path policy sends the runtime down its capability walk (directory handles, no-follow opens,
 * a policy check per entry); without one it takes the ambient `read_dir` walk. The ratio between
 * the two is what a restricted chat pays for the same answer. Each sample is a fresh child under
 * a throwaway `MANGO_HOME`, one request per child, so no sample warms another's caches inside the
 * runtime. The page cache is shared and warm: run a warm-up first.
 *
 * Usage:
 *   bun run scripts/bench/fs-walk.ts                       # newest target/ build, synthetic tree
 *   bun run scripts/bench/fs-walk.ts base=<old> head=<new> --runs 15 --warmup 3
 *   bun run scripts/bench/fs-walk.ts <binary> --tree /path/to/repo
 *   bun run scripts/bench/fs-walk.ts <binary> --dirs 200 --files-per-dir 100 --json
 *
 * Several binaries rotate their run order (ABBA for two). The synthetic tree has `--dirs`
 * directories of `--files-per-dir` small files; every fifth file is a `.ts` file holding the
 * grep needle. Each sample records the match count, so a faster run that answers less shows up.
 */

import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

import { Session } from '@mangostudio/protocol';
import { spawnPort } from '@mangostudio/protocol/spawn';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
} from '@mangostudio/shared/runtime-contract';

import { fatal, parseArgs } from '../lib/args';
import { rotatedOrder } from '../lib/bench-order';
import { summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';
import { buildProfileOf, newestWorkspaceBuild } from './runtime-binary';

const HANDSHAKE_CEILING_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const REPO_ROOT = resolve(import.meta.dir, '../..');
const NEEDLE = 'needle-7731';
const TS_FILE_STRIDE = 5;
const SMALL_FILE = `const filler = 1;\nexport const value = '${NEEDLE}';\nconst tail = 2;\n`;

const CALLS = ['glob', 'grep'] as const;
const MODES = ['ambient', 'restricted'] as const;
type Call = (typeof CALLS)[number];
type Mode = (typeof MODES)[number];

interface Candidate {
  readonly label: string;
  readonly binary: string;
}

interface Sample {
  readonly elapsedMs: number;
  readonly matches: number;
  readonly truncated: boolean;
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/fs-walk.ts [[label=]binary ...] [--runs N] [--warmup N] [--tree PATH | --dirs N --files-per-dir N] [--case NAME] [--json]

  [label=]binary    mangostudio-runtime executables, interleaved run by run in a rotating order
  --runs N          Measured runs per call and mode (default 15)
  --warmup N        Untimed runs per binary, call and mode (default 2)
  --tree PATH       Walk this existing tree instead of generating one
  --dirs N          Directories in the generated tree (default 200)
  --files-per-dir N Files per generated directory (default 100)
  --case NAME       Run one case only: glob-ambient, glob-restricted, grep-ambient or grep-restricted
  --json            Print only the JSON result
  --help            Show this help message`);
  process.exit(0);
}

async function writeTree(root: string, dirs: number, filesPerDir: number): Promise<void> {
  for (let directory = 0; directory < dirs; directory += 1) {
    const path = join(root, `dir-${directory}`);
    await mkdir(path, { recursive: true });
    await Promise.all(
      Array.from({ length: filesPerDir }, (_, file) =>
        writeFile(
          join(path, `file-${file}.${file % TS_FILE_STRIDE === 0 ? 'ts' : 'txt'}`),
          SMALL_FILE
        )
      )
    );
  }
}

/** The shape the hub sends for a restricted chat: roots and containment all naming the tree. */
function pathPolicy(tree: string) {
  return { allowedRoots: [tree], deniedRoots: [], containmentRoot: tree };
}

function requestFor(call: Call, mode: Mode, tree: string) {
  const policy = mode === 'restricted' ? { pathPolicy: pathPolicy(tree) } : {};
  if (call === 'glob') {
    return {
      method: 'fs.glob',
      params: {
        ...policy,
        pattern: '**/*.ts',
        cwd: tree,
        maxResults: 10_000_000,
        includeDotfiles: false,
        absolute: false,
      },
    };
  }
  return {
    method: 'fs.grep',
    params: {
      ...policy,
      pattern: NEEDLE,
      inputPath: tree,
      resolvedPath: tree,
      glob: '**/*.ts',
      caseInsensitive: false,
      maxResults: 10_000_000,
      maxMatchesPerFile: 10_000_000,
      maxFileSizeBytes: 1_000_000,
      includeDotfiles: false,
    },
  };
}

async function timedRequest(
  binary: string,
  mangoHome: string,
  request: ReturnType<typeof requestFor>
): Promise<Sample> {
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
    // Untimed: the first request pays lazy initialisation no walk should be charged for.
    await session.request('runtime.health', {}, { timeoutMs: REQUEST_TIMEOUT_MS });
    const startedAt = performance.now();
    const result = (await session.request(request.method, request.params, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    })) as { matches: readonly unknown[]; truncated: boolean };
    return {
      elapsedMs: performance.now() - startedAt,
      matches: result.matches.length,
      truncated: result.truncated,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nRuntime stderr:\n${peer.stderrTail().trim().slice(-2_000)}`);
  } finally {
    session.closeNow();
    await peer.terminate();
  }
}

function parseCandidate(argument: string): Candidate {
  const separator = argument.indexOf('=');
  if (separator <= 0) return { label: 'binary', binary: resolve(argument) };
  return { label: argument.slice(0, separator), binary: resolve(argument.slice(separator + 1)) };
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    fatal(`\`${name}\` must be a non-negative integer | received: ${raw}`);
  }
  return value;
}

const { flags, values, positional } = parseArgs({
  booleanFlags: ['--json'],
  valueFlags: ['--runs', '--warmup', '--tree', '--dirs', '--files-per-dir', '--case'],
});
if (flags['--help']) printHelp();

const candidates: Candidate[] = positional.splice(0).map(parseCandidate);
if (candidates.length === 0) {
  const newest = await newestWorkspaceBuild(REPO_ROOT);
  if (!newest) {
    fatal(
      'No runtime binary. Build one with `cargo build --profile release-fast -p mangostudio-runtime --locked`.'
    );
  }
  candidates.push({ label: 'binary', binary: newest });
}
for (const { binary } of candidates) {
  if (!(await Bun.file(binary).exists())) fatal(`No such binary: ${binary}`);
}
if (new Set(candidates.map(({ label }) => label)).size !== candidates.length) {
  fatal(
    `binary labels must be unique | received: ${candidates.map(({ label }) => label).join(', ')}`
  );
}

const runs = positiveInteger('--runs', values['--runs'], 15);
const warmup = positiveInteger('--warmup', values['--warmup'], 2);
const dirs = positiveInteger('--dirs', values['--dirs'], 200);
const filesPerDir = positiveInteger('--files-per-dir', values['--files-per-dir'], 100);
const quiet = flags['--json'] ?? false;
const onlyCase = values['--case'];
if (onlyCase && !CALLS.some((call) => MODES.some((mode) => onlyCase === `${call}-${mode}`))) {
  fatal(`\`--case\` must be <glob|grep>-<ambient|restricted> | received: ${onlyCase}`);
}

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mango-fs-walk-bench-')));
const results: Record<string, unknown> = {};
try {
  const explicitTree = values['--tree'];
  const tree = explicitTree ? await realpath(resolve(explicitTree)) : join(scratch, 'tree');
  if (explicitTree) {
    if (!(await stat(tree)).isDirectory()) fatal(`--tree must be a directory | received: ${tree}`);
  } else {
    await writeTree(tree, dirs, filesPerDir);
  }
  if (!quiet) {
    header('fs.glob and fs.grep walk benchmark');
    info(
      `${candidates.map(({ label, binary }) => `${label}=${binary} (${buildProfileOf(binary)})`).join(' vs ')} over ${tree}, ${runs} run(s) after ${warmup} warm-up`
    );
  }
  for (const call of CALLS) {
    for (const mode of MODES) {
      if (onlyCase && onlyCase !== `${call}-${mode}`) continue;
      const request = requestFor(call, mode, tree);
      const samples = new Map<string, Sample[]>(candidates.map(({ label }) => [label, []]));
      const loadBefore = loadavg()[0] ?? 0;
      for (let run = -warmup; run < runs; run += 1) {
        for (const { label, binary } of rotatedOrder(candidates, run)) {
          const home = join(scratch, `home-${call}-${mode}-${label}-${run + warmup}`);
          const sample = await timedRequest(binary, home, request);
          if (run < 0) continue;
          samples.get(label)?.push(sample);
          if (!quiet) {
            info(
              `  ${call} ${mode} ${label} run ${run + 1}/${runs}: ${sample.elapsedMs.toFixed(1)} ms, ${sample.matches} match(es)${sample.truncated ? ', truncated' : ''}`
            );
          }
        }
      }
      const perBinary: Record<string, unknown> = {};
      for (const [label, own] of samples) {
        perBinary[label] = {
          matches: own[0]?.matches,
          elapsedMs: summarizeLatencies(own.map((sample) => sample.elapsedMs)),
          rawElapsedMs: own.map((sample) => Math.round(sample.elapsedMs * 10) / 10),
          rawMatches: own.map((sample) => sample.matches),
          rawTruncated: own.map((sample) => sample.truncated),
        };
      }
      results[`${call}-${mode}`] = {
        loadAverage1mBefore: loadBefore,
        loadAverage1mAfter: loadavg()[0] ?? 0,
        binaries: perBinary,
      };
    }
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
          tree: explicitTree ? tree : `${dirs} dirs x ${filesPerDir} files`,
          binaries: candidates.map(({ label, binary }) => ({
            label,
            binary,
            buildProfile: buildProfileOf(binary),
          })),
          order: 'rotated every run: ABBA for two candidates',
        },
        runs,
        warmup,
        calls: results,
      },
      null,
      2
    )
  );
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
