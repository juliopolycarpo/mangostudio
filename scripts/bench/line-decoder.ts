#!/usr/bin/env bun

/**
 * Measures the protocol's NDJSON `LineDecoder`: time per input byte to
 * reassemble large records fed in small pieces, and many short records, plus
 * peak resident memory.
 *
 * The decoder comes from a module path, so a base and a head checkout run the
 * same scenarios: pass each checkout's `packages/protocol/src/codec/ndjson.ts`.
 * Each scenario runs in a fresh `bun` child, so its peak RSS (`VmHWM`, Linux
 * only) is that scenario's alone. A child makes one warm-up pass, then
 * `--runs` timed passes. A pass feeds the input in fixed-size pieces, calls
 * `finish`, and checks the frame count, so a fast wrong answer fails.
 *
 * Usage:
 *   bun run scripts/bench/line-decoder.ts <ndjson-module> [--runs N] [--scenario a,b]
 */

import { resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { summarizeLatencies } from '../lib/latency-stats';
import { log } from '../lib/log';

const KIB = 1024;
const MIB = 1024 * KIB;
const encoder = new TextEncoder();

/** The slice of `LineDecoder` a pass drives; every revision has it. */
interface BenchedLineDecoder {
  push(chunk: Uint8Array): {
    readonly frames: readonly unknown[];
    readonly error?: { readonly message: string };
  };
  finish(): { readonly frames: readonly unknown[]; readonly error?: { readonly message: string } };
}

type LineDecoderFactory = () => BenchedLineDecoder;

export interface DecoderScenario {
  readonly name: string;
  readonly pieceBytes: number;
  readonly input: () => { readonly bytes: Uint8Array; readonly frames: number };
}

/** One `res` frame whose line, terminator included, is `lineBytes` long. */
export function oneLineInput(lineBytes: number): { bytes: Uint8Array; frames: number } {
  const overhead = `${JSON.stringify({ type: 'res', id: 'r1', result: '' })}\n`.length;
  const result = 'a'.repeat(lineBytes - overhead);
  return {
    bytes: encoder.encode(`${JSON.stringify({ type: 'res', id: 'r1', result })}\n`),
    frames: 1,
  };
}

/** `count` streaming-sized `req` frames of about 100 bytes, some with multi-byte text. */
export function shortLinesInput(count: number): { bytes: Uint8Array; frames: number } {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const params = { seq: index, delta: index % 7 === 0 ? 'héllo wörld 🥭' : 'hello world' };
    lines.push(JSON.stringify({ type: 'req', id: `r${index}`, method: 'turn.delta', params }));
  }
  return { bytes: encoder.encode(`${lines.join('\n')}\n`), frames: count };
}

/**
 * Pipe reads on Linux run from 4 KiB to a few hundred KiB; the 1 B and 16 B
 * pieces are stress cases that bound the per-push overhead.
 */
export const DECODER_SCENARIOS: readonly DecoderScenario[] = [
  { name: 'line-10MiB/128KiB', pieceBytes: 128 * KIB, input: () => oneLineInput(10 * MIB) },
  { name: 'line-1MiB/64KiB', pieceBytes: 64 * KIB, input: () => oneLineInput(MIB) },
  { name: 'line-1MiB/4KiB', pieceBytes: 4 * KIB, input: () => oneLineInput(MIB) },
  { name: 'line-1MiB/16B', pieceBytes: 16, input: () => oneLineInput(MIB) },
  { name: 'line-64KiB/1B', pieceBytes: 1, input: () => oneLineInput(64 * KIB) },
  { name: 'short-10k/64KiB', pieceBytes: 64 * KIB, input: () => shortLinesInput(10_000) },
  { name: 'short-10k/4KiB', pieceBytes: 4 * KIB, input: () => shortLinesInput(10_000) },
  { name: 'short-10k/16B', pieceBytes: 16, input: () => shortLinesInput(10_000) },
  { name: 'short-10k/1B', pieceBytes: 1, input: () => shortLinesInput(10_000) },
];

/**
 * Feeds `bytes` to a fresh decoder in `pieceBytes` pieces, finishes it, and
 * returns the elapsed milliseconds. Throws on a refusal or a wrong frame count.
 */
export function timeDecoderPass(
  createDecoder: LineDecoderFactory,
  bytes: Uint8Array,
  pieceBytes: number,
  expectedFrames: number
): number {
  const decoder = createDecoder();
  let frames = 0;
  const startedAt = Bun.nanoseconds();
  for (let offset = 0; offset < bytes.byteLength; offset += pieceBytes) {
    const outcome = decoder.push(bytes.subarray(offset, offset + pieceBytes));
    if (outcome.error) throw new Error(`expected no refusal | received: ${outcome.error.message}`);
    frames += outcome.frames.length;
  }
  const last = decoder.finish();
  if (last.error) throw new Error(`expected no refusal | received: ${last.error.message}`);
  frames += last.frames.length;
  const elapsedMs = (Bun.nanoseconds() - startedAt) / 1e6;
  if (frames !== expectedFrames) {
    throw new Error(`expected frames: ${expectedFrames} | received: ${frames}`);
  }
  return elapsedMs;
}

async function loadDecoderFactory(modulePath: string): Promise<LineDecoderFactory> {
  const loaded = (await import(modulePath)) as {
    LineDecoder?: new (options: { maxFrameBytes: number }) => BenchedLineDecoder;
  };
  const LineDecoder = loaded.LineDecoder;
  if (typeof LineDecoder !== 'function') {
    fatal(`expected a module exporting class LineDecoder | received: ${modulePath}`);
  }
  return () => new LineDecoder({ maxFrameBytes: 16 * MIB });
}

function peakRssMiB(status: string): number | null {
  const kib = /^VmHWM:\s+(\d+) kB/m.exec(status)?.[1];
  return kib === undefined ? null : Math.round((Number(kib) / 1024) * 10) / 10;
}

/** The child: one scenario, one JSON line on stdout. */
async function measureScenario(modulePath: string, scenarioName: string, runs: number) {
  const scenario = DECODER_SCENARIOS.find((candidate) => candidate.name === scenarioName);
  if (!scenario) fatal(`expected a scenario from --help | received: ${scenarioName}`);
  const createDecoder = await loadDecoderFactory(modulePath);
  const { bytes, frames } = scenario.input();
  timeDecoderPass(createDecoder, bytes, scenario.pieceBytes, frames);
  const samplesMs: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    samplesMs.push(timeDecoderPass(createDecoder, bytes, scenario.pieceBytes, frames));
  }
  const nsPerByte = summarizeLatencies(samplesMs.map((ms) => (ms * 1e6) / bytes.byteLength));
  const status = await Bun.file('/proc/self/status')
    .text()
    .catch(() => '');
  console.log(
    JSON.stringify({
      scenario: scenario.name,
      inputBytes: bytes.byteLength,
      pushes: Math.ceil(bytes.byteLength / scenario.pieceBytes),
      ms: summarizeLatencies(samplesMs),
      nsPerByte,
      peakRssMiB: peakRssMiB(status),
    })
  );
}

function printHelp(): never {
  log(`Usage:
  bun run scripts/bench/line-decoder.ts <ndjson-module> [--runs N] [--scenario a,b]

  <ndjson-module>  A checkout's packages/protocol/src/codec/ndjson.ts
  --runs           Timed passes per scenario, after one warm-up (default 7)
  --scenario       Comma-separated subset of: ${DECODER_SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(0);
}

if (import.meta.main) {
  const { values, positional, flags } = parseArgs({ valueFlags: ['--runs', '--scenario'] });
  if (flags['--help']) printHelp();
  const runs = Number(values['--runs'] ?? 7);
  if (!Number.isInteger(runs) || runs < 1) {
    fatal(`\`--runs\` must be a positive integer | received: ${values['--runs']}`);
  }
  const [first, second] = positional;
  if (first === 'measure' && second && values['--scenario']) {
    assertNoUnexpectedArguments(positional.slice(2));
    await measureScenario(second, values['--scenario'], runs);
  } else if (first) {
    assertNoUnexpectedArguments(positional.slice(1));
    const modulePath = resolve(first);
    const names = values['--scenario']?.split(',') ?? DECODER_SCENARIOS.map((s) => s.name);
    for (const name of names) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          import.meta.path,
          'measure',
          modulePath,
          '--scenario',
          name,
          '--runs',
          String(runs),
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      if (child.exitCode !== 0) {
        fatal(
          `(${name}) expected exit 0 | received: ${child.exitCode}\n${child.stderr.toString()}`
        );
      }
      process.stdout.write(child.stdout.toString());
    }
  } else {
    fatal('expected `<ndjson-module>` | received: (nothing)');
  }
}
