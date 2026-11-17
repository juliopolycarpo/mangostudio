#!/usr/bin/env bun

/**
 * Measures what the chat's markdown renderer does for each chunk of a streamed answer, in
 * process: the work `MarkdownContentRenderer` runs per render, without React and the DOM.
 *
 * Two strategies, over the same long mixed answer (headings, prose with inline code and links,
 * lists, tables, fenced code, quotes) cut into N chunks:
 *
 * - `whole`: what the renderer did before it was incremental. Parse the whole text with the
 *   app's parser, and lex the whole text again to find the fence languages.
 * - `incremental`: `IncrementalLexer` (tail only) + the language scan over its tokens +
 *   `IncrementalBlockRenderer` (changed tokens only).
 *
 * `whole` is also split into where its time goes: lexing, rendering the tokens to HTML with
 * the app's renderer (which is also the escaping step), and the language scan's second lex.
 * The incremental output is compared with the whole parse at the end of each pass, and at
 * every 25th chunk, so a faster wrong answer fails instead of reporting a number.
 *
 * Code blocks are drawn plain here: Shiki has its own per-block sessions and is measured by
 * its own tests. The DOM step is measured in Chromium, not here.
 *
 * Usage:
 *   bun run scripts/bench/markdown-stream.ts [--frontend-dir apps/frontend] [--runs N]
 *     [--chunks 200,2000] [--chars 120000] [--json]
 */

import { resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { log } from '../lib/log';

const DEFAULT_CHUNK_COUNTS = [200, 2000] as const;
const DEFAULT_CHARS = 120_000;
const WINDOW = 50;
const VERIFY_EVERY = 25;

export const STRATEGIES = ['whole', 'incremental'] as const;
export type Strategy = (typeof STRATEGIES)[number];

interface Token {
  readonly type: string;
  readonly raw: string;
}
interface MarkedLike {
  parse(text: string, options: { async: false }): string;
  parser(tokens: Token[], options: unknown): string;
  walkTokens(tokens: Token[], callback: (token: Token) => void): unknown;
  defaults: unknown;
}
export interface MarkdownModules {
  readonly Marked: new (options: Record<string, unknown>) => MarkedLike;
  readonly lex: (text: string, options: unknown) => Token[];
  readonly createParser: (theme: string, label: string, highlighter: null) => MarkedLike;
  readonly lexerOptions: unknown;
  readonly IncrementalLexer: new (options: unknown) => {
    update(text: string): { tokens: readonly Token[]; splittable: boolean };
  };
  readonly IncrementalBlockRenderer: new (parser: MarkedLike) => {
    render(tokens: { tokens: readonly Token[]; splittable: boolean }): readonly string[];
  };
  readonly detectCodeLanguages: (tokens: readonly Token[]) => string[];
}

export interface ChunkTimings {
  readonly strategy: Strategy;
  readonly chunks: number;
  readonly chars: number;
  readonly totalMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly worstMs: number;
  readonly firstMeanMs: number;
  readonly lastMeanMs: number;
}

/** A long answer in the shapes a model writes: prose, lists, tables, code, quotes. About `chars` long. */
export function buildMixedAnswer(chars: number): string {
  const sections: string[] = [];
  let length = 0;
  for (let index = 0; length < chars; index++) {
    const section = [
      `## Step ${index + 1}: ${['Parsing', 'Caching', 'Routing', 'Streaming'][index % 4]}`,
      '',
      `The ${index + 1}th change touches \`module_${index}\` and its [guide](https://docs.example/guide/${index}). ` +
        'It keeps the **hot path** short, so *every* call stays cheap even when the input grows ' +
        'past what the old version handled, and it avoids a second pass over the same data.',
      '',
      ...Array.from(
        { length: 5 },
        (_, item) => `- item ${item} of section ${index}, with \`code\``
      ),
      '',
      ...Array.from({ length: 4 }, (_, item) => `${item + 1}. ordered step ${item} for ${index}`),
      '',
      '| name | cost | note |',
      '| --- | ---: | :-: |',
      ...Array.from({ length: 4 }, (_, row) => `| row ${row} | ${row * 3 + index} ms | ok |`),
      '',
      '```ts',
      ...Array.from(
        { length: 22 },
        (_, line) =>
          `const value${index}_${line} = compute(${line}, "input ${index}"); // line ${line}`
      ),
      '```',
      '',
      `> Note ${index}: measure before you change it.`,
      '',
      `Closing paragraph for section ${index}, with a few more words so the prose is not all lists.`,
      '',
    ].join('\n');
    sections.push(section);
    length += section.length;
  }
  return sections.join('\n');
}

/** `count` prefixes of `text`, each `ceil(length / count)` characters longer than the last. */
export function buildPrefixes(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count);
  return Array.from({ length: count }, (_, index) =>
    text.slice(0, Math.min(text.length, (index + 1) * size))
  );
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Summarizes per-chunk times in milliseconds. */
export function summarizeChunkTimes(
  strategy: Strategy,
  chars: number,
  times: readonly number[]
): ChunkTimings {
  const sorted = [...times].sort((left, right) => left - right);
  return {
    strategy,
    chunks: times.length,
    chars,
    totalMs: times.reduce((sum, value) => sum + value, 0),
    medianMs: median(times),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    worstMs: sorted.at(-1) ?? 0,
    firstMeanMs: mean(times.slice(0, WINDOW)),
    lastMeanMs: mean(times.slice(-WINDOW)),
  };
}

/** The per-chunk work of the pre-incremental renderer. */
function createWholeStep(modules: MarkdownModules) {
  const parser = modules.createParser('one-dark-pro', 'Copy', null);
  const languageWalker = new modules.Marked({ gfm: true, breaks: true });
  return (text: string): string => {
    const html = parser.parse(text, { async: false });
    // The language scan lexed the whole text a second time.
    let fences = 0;
    languageWalker.walkTokens(modules.lex(text, modules.lexerOptions), (token) => {
      if (token.type === 'code') fences += 1;
    });
    return fences >= 0 ? html : '';
  };
}

function createIncrementalStep(modules: MarkdownModules) {
  const parser = modules.createParser('one-dark-pro', 'Copy', null);
  const lexer = new modules.IncrementalLexer(modules.lexerOptions);
  const renderer = new modules.IncrementalBlockRenderer(parser);
  return (text: string): string => {
    const tokens = lexer.update(text);
    modules.detectCodeLanguages(tokens.tokens);
    return renderer.render(tokens).join('');
  };
}

/** One pass over `prefixes`; returns the time of each chunk and checks the output against a whole parse. */
export function runPass(
  modules: MarkdownModules,
  strategy: Strategy,
  prefixes: readonly string[]
): number[] {
  const step = strategy === 'whole' ? createWholeStep(modules) : createIncrementalStep(modules);
  const reference = modules.createParser('one-dark-pro', 'Copy', null);
  const times: number[] = [];
  prefixes.forEach((prefix, index) => {
    const started = performance.now();
    const html = step(prefix);
    times.push(performance.now() - started);
    if (index % VERIFY_EVERY === 0 || index === prefixes.length - 1) {
      const expected = reference.parse(prefix, { async: false });
      if (html !== expected) {
        fatal(
          `(${strategy}): chunk ${index} of ${prefixes.length} differs from a whole parse | ` +
            `expected ${expected.length} chars | received ${html.length} chars`
        );
      }
    }
  });
  return times;
}

/** Where the whole renderer's time goes, over the same prefixes: lex, render tokens, second lex for languages. */
export function measurePhases(
  modules: MarkdownModules,
  prefixes: readonly string[]
): { lexMs: number; renderMs: number; languageScanMs: number } {
  const parser = modules.createParser('one-dark-pro', 'Copy', null);
  const walker = new modules.Marked({ gfm: true, breaks: true });
  let lexMs = 0;
  let renderMs = 0;
  let languageScanMs = 0;
  for (const prefix of prefixes) {
    let started = performance.now();
    const tokens = modules.lex(prefix, modules.lexerOptions);
    lexMs += performance.now() - started;
    started = performance.now();
    parser.parser(tokens, parser.defaults);
    renderMs += performance.now() - started;
    started = performance.now();
    walker.walkTokens(modules.lex(prefix, modules.lexerOptions), () => undefined);
    languageScanMs += performance.now() - started;
  }
  return { lexMs, renderMs, languageScanMs };
}

export async function loadModules(frontendDir: string): Promise<MarkdownModules> {
  const marked = (await import(Bun.resolveSync('marked', frontendDir))) as {
    Marked: MarkdownModules['Marked'];
    Lexer: { lex: MarkdownModules['lex'] };
  };
  const parserModule = (await import(resolve(frontendDir, 'src/lib/markdown-parser.ts'))) as {
    createParser: MarkdownModules['createParser'];
    MARKDOWN_LEXER_OPTIONS: unknown;
  };
  const blocks = (await import(resolve(frontendDir, 'src/lib/markdown-blocks.ts'))) as {
    IncrementalLexer: MarkdownModules['IncrementalLexer'];
    IncrementalBlockRenderer: MarkdownModules['IncrementalBlockRenderer'];
  };
  const languages = (await import(resolve(frontendDir, 'src/lib/markdown-code-languages.ts'))) as {
    detectCodeLanguages: MarkdownModules['detectCodeLanguages'];
  };
  return {
    Marked: marked.Marked,
    lex: (text, options) => marked.Lexer.lex(text, options),
    createParser: parserModule.createParser,
    lexerOptions: parserModule.MARKDOWN_LEXER_OPTIONS,
    IncrementalLexer: blocks.IncrementalLexer,
    IncrementalBlockRenderer: blocks.IncrementalBlockRenderer,
    detectCodeLanguages: languages.detectCodeLanguages,
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printHelp(): never {
  log(`Usage:
  bun run scripts/bench/markdown-stream.ts [--frontend-dir apps/frontend] [--runs N]
    [--chunks 200,2000] [--chars 120000] [--json]

  --frontend-dir  A checkout's apps/frontend (default: this checkout)
  --runs          Timed passes per scenario, after one warm-up (default 3)
  --chunks        Comma-separated chunk counts (default ${DEFAULT_CHUNK_COUNTS.join(',')})
  --chars         Length of the answer in characters (default ${DEFAULT_CHARS})
  --json          One JSON line per scenario instead of a table`);
  process.exit(0);
}

function parsePositiveIntegers(flag: string, raw: string): number[] {
  return raw.split(',').map((item) => {
    const value = Number(item);
    if (!Number.isInteger(value) || value < 1) {
      fatal(`\`${flag}\` must be positive integers | received: ${raw}`);
    }
    return value;
  });
}

if (import.meta.main) {
  const { values, positional, flags } = parseArgs({
    valueFlags: ['--frontend-dir', '--runs', '--chunks', '--chars'],
    booleanFlags: ['--json'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);
  const [runs = 3] = parsePositiveIntegers('--runs', values['--runs'] ?? '3');
  const [chars = DEFAULT_CHARS] = parsePositiveIntegers(
    '--chars',
    values['--chars'] ?? `${DEFAULT_CHARS}`
  );
  const counts = values['--chunks']
    ? parsePositiveIntegers('--chunks', values['--chunks'])
    : [...DEFAULT_CHUNK_COUNTS];
  const modules = await loadModules(resolve(values['--frontend-dir'] ?? 'apps/frontend'));
  const answer = buildMixedAnswer(chars);
  if (!flags['--json']) {
    log(`answer: ${answer.length} chars | runs: ${runs} (median-total pass of each) | times in ms`);
    log('strategy      chunks  total   median  p95     worst   first50  last50');
  }
  for (const count of counts) {
    const prefixes = buildPrefixes(answer, count);
    for (const strategy of STRATEGIES) {
      runPass(modules, strategy, prefixes);
      const passes = Array.from({ length: runs }, () =>
        summarizeChunkTimes(strategy, answer.length, runPass(modules, strategy, prefixes))
      );
      const chosen =
        [...passes]
          .sort((left, right) => left.totalMs - right.totalMs)
          .at(Math.floor(passes.length / 2)) ??
        fatal(`expected at least one timed pass | received: ${passes.length}`);
      const summary = Object.fromEntries(
        Object.entries(chosen).map(([key, value]) => [
          key,
          typeof value === 'number' ? round(value) : value,
        ])
      );
      if (flags['--json']) console.log(JSON.stringify(summary));
      else {
        const cell = (value: unknown, width: number) => String(value).padStart(width);
        log(
          `${strategy.padEnd(12)} ${cell(count, 7)} ${cell(summary.totalMs, 7)} ${cell(summary.medianMs, 7)} ${cell(summary.p95Ms, 7)} ${cell(summary.worstMs, 7)} ${cell(summary.firstMeanMs, 8)} ${cell(summary.lastMeanMs, 7)}`
        );
      }
    }
    const phases = measurePhases(modules, prefixes);
    const split = Object.fromEntries(
      Object.entries(phases).map(([key, value]) => [key, round(value)])
    );
    if (flags['--json']) console.log(JSON.stringify({ chunks: count, phases: split }));
    else {
      log(
        `  whole, where the time goes over ${count} chunks: lex ${split.lexMs} ms | render tokens (escaping included) ${split.renderMs} ms | language scan lex ${split.languageScanMs} ms`
      );
    }
  }
}
