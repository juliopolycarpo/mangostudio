#!/usr/bin/env bun

/**
 * Measures what compressing the hub's JSON responses would cost and save.
 *
 * Starts a real hub (from source) under a throwaway home, seeds its database with a realistic
 * transcript (tool results are slices of this repository's own sources) and chat list, then reports:
 *
 *   sizes   per endpoint: raw bytes, and gzip / zstd / Brotli bytes with compress time. The hub
 *           ships Bun-native gzip and zstd only; Brotli is a size reference (`node:zlib`, never in
 *           the hub, where it adds 184 KB to the compiled binary).
 *   model   the link speed below which compressing wins end to end: gzip saves `raw - gzip` bytes
 *           and costs compress + inflate milliseconds, so it wins when the link is slower than
 *           `saved * 8 / cost` (Mbit/s).
 *   serve   hub CPU and latency per request for one endpoint, from the loopback address and from
 *           this host's own LAN address (a real non-loopback peer), with and without
 *           `Accept-Encoding: gzip`. Rounds rotate the order of the four cases.
 *
 * Usage:
 *   bun run scripts/bench/api-json-compression.ts sizes --runs 30
 *   bun run scripts/bench/api-json-compression.ts serve --runs 9 --requests 20
 *   bun run scripts/bench/api-json-compression.ts sizes --json
 *   bun run scripts/bench/api-json-compression.ts serve --hub-dir ../base-checkout
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { rotatedOrder } from '../lib/bench-order';
import { type LatencySummary, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const AUTH_SECRET = 'api-json-compression-bench-secret-at-least-32-chars';
const EMAIL = 'bench@example.test';
const PASSWORD = 'api-json-bench-password-123';
const CLOCK_TICKS_PER_SECOND = 100;

/** The `limit` the frontend asks for (`MESSAGES_PAGE_SIZE`), and a deliberately large page. */
const FRONTEND_PAGE = 50;
const LARGE_PAGE = 500;

/** One response worth measuring: a name for the table and the path to GET. */
export interface Endpoint {
  readonly name: string;
  readonly path: string;
}

/**
 * Link speed in Mbit/s below which spending `costMs` of CPU to save `savedBytes` finishes sooner.
 *
 * Plain transfer takes `raw / link`; compressed takes `cost + gzip / link`; they meet at
 * `link = saved / cost`. Returns 0 when nothing was saved, since no link speed makes that win.
 *
 * @example
 * breakEvenMbps(500_000, 4); // 1000 (500 KB saved for 4 ms pays below a 1 Gbit/s link)
 */
export function breakEvenMbps(savedBytes: number, costMs: number): number {
  if (!(costMs > 0)) {
    throw new Error(`expected a positive cost in ms | received: ${String(costMs)}`);
  }
  if (savedBytes <= 0) return 0;
  return (savedBytes * 8) / (costMs * 1000);
}

/** Wall time for sending `bytes` over a `mbps` link, in ms. */
export function transferMs(bytes: number, mbps: number): number {
  return (bytes * 8) / (mbps * 1000);
}

const TITLES = [
  'Fix flaky websocket reconnect test',
  'Refactor settings page into sections',
  'Explain the checkpoint delta format',
  'Add pagination to the activity feed',
  'Why does the terminal drop the last line',
  'Migrate connectors table',
  'Review the runtime handshake',
  'Draft release notes',
];

/**
 * A transcript shaped like an agent turn: a short user prompt, then an answer with a reasoning
 * part, text, and several tool calls whose results are slices of real source files. Deterministic
 * for a given `corpus` and `seed`, so a re-run measures the same bytes.
 */
export function buildTranscriptRows(
  corpus: readonly string[],
  count: number,
  seed: number
): Array<{ role: 'user' | 'ai'; text: string; parts: string | null }> {
  if (corpus.length === 0) throw new Error('expected a non-empty corpus | received: []');
  let state = seed >>> 0 || 1;
  const next = (bound: number): number => {
    // xorshift32: small, deterministic, and good enough to vary slice sizes.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
  const rows: Array<{ role: 'user' | 'ai'; text: string; parts: string | null }> = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) {
      rows.push({
        role: 'user',
        text: `Look at ${TITLES[next(TITLES.length)]} and tell me what is wrong, then fix it.`,
        parts: null,
      });
      continue;
    }
    const parts: unknown[] = [{ type: 'thinking', text: slice(corpus, next, 400, 1500) }];
    const toolCount = 2 + next(3);
    for (let call = 0; call < toolCount; call += 1) {
      const toolCallId = `call_${randomUUID().slice(0, 12)}`;
      parts.push({
        type: 'tool_call',
        toolCallId,
        name: 'read_file',
        args: { path: `apps/api/src/example-${next(900)}.ts` },
      });
      parts.push({
        type: 'tool_result',
        toolCallId,
        content: slice(corpus, next, 1500, 14_000),
      });
    }
    const answer = slice(corpus, next, 600, 2500);
    parts.push({ type: 'text', text: answer });
    rows.push({ role: 'ai', text: answer, parts: JSON.stringify(parts) });
  }
  return rows;
}

function slice(
  corpus: readonly string[],
  next: (bound: number) => number,
  minChars: number,
  maxChars: number
): string {
  const file = corpus[next(corpus.length)] as string;
  const length = Math.min(file.length, minChars + next(maxChars - minChars));
  const start = next(Math.max(1, file.length - length));
  return file.slice(start, start + length);
}

/** Source files of this repository, the realistic text a tool result carries. */
async function loadCorpus(limit: number): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob('apps/api/src/**/*.ts').scan({ cwd: REPO_ROOT })) {
    const text = readFileSync(join(REPO_ROOT, path), 'utf8');
    if (text.length > 2000) files.push(text);
    if (files.length >= limit) break;
  }
  if (files.length === 0) fatal('no source files found to build a transcript from');
  return files;
}

interface HubOptions {
  readonly hubDir: string;
  readonly homeParent: string;
  readonly runtimeBinary: string | undefined;
}

interface RunningHub {
  readonly pid: number;
  readonly port: number;
  readonly home: string;
  readonly databasePath: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '0.0.0.0', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Starts the hub on every interface, so the host's own LAN address reaches it as a remote peer. */
async function startHub(options: HubOptions): Promise<RunningHub> {
  mkdirSync(options.homeParent, { recursive: true });
  const home = mkdtempSync(join(options.homeParent, 'compression-'));
  const port = await freePort();
  const databasePath = join(home, 'database.sqlite');
  const logPath = join(home, 'hub.log');
  const child = Bun.spawn(
    ['bun', join(options.hubDir, 'apps/api/src/index.ts'), 'serve', String(port)],
    {
      cwd: options.hubDir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        USERPROFILE: home,
        NODE_ENV: 'production',
        MANGO_HOME: home,
        API_PORT: String(port),
        API_HOST: '0.0.0.0',
        AUTH_SECRET,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        DATABASE_PATH: databasePath,
        UPLOADS_DIR: join(home, 'uploads'),
        IMAGES_DIR: join(home, 'images'),
        TOOL_IMAGES_DIR: join(home, 'tool-images'),
        MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
        ...(options.runtimeBinary ? { MANGOSTUDIO_RUNTIME_BINARY: options.runtimeBinary } : {}),
      },
      stdin: 'ignore',
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
    }
  );
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.text();
      if (response.status === 200) break;
    } catch {
      // Still starting.
    }
    await Bun.sleep(50);
  }
  if (child.exitCode !== null || performance.now() >= deadline) {
    child.kill('SIGKILL');
    fatal(`hub did not become healthy within 120 s | see ${logPath}`);
  }
  return {
    pid: child.pid,
    port,
    home,
    databasePath,
    async stop() {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(30_000).then(() => false),
      ]);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

/** A signed-in client; `base` picks which of the host's addresses the hub sees as the peer. */
class HubClient {
  private cookie = '';
  constructor(
    readonly base: string,
    private readonly origin: string
  ) {}

  withBase(base: string): HubClient {
    const copy = new HubClient(base, this.origin);
    copy.cookie = this.cookie;
    return copy;
  }

  async signUp(): Promise<void> {
    const response = await fetch(`${this.base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.origin },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Bench' }),
    });
    const text = await response.text();
    if (!response.ok)
      fatal(`sign-up: expected 2xx | received ${response.status}: ${text.slice(0, 300)}`);
    this.cookie = response.headers
      .getSetCookie()
      .map((line) => (line.split(';')[0] as string).trim())
      .join('; ');
  }

  /** GET with an exact `Accept-Encoding` and no transparent decoding of the size we report. */
  async get(
    path: string,
    acceptEncoding: string
  ): Promise<{ status: number; headers: Headers; body: Bytes }> {
    const response = await fetch(`${this.base}${path}`, {
      headers: { Cookie: this.cookie, Origin: this.origin, 'Accept-Encoding': acceptEncoding },
      decompress: false,
    } as RequestInit);
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }
}

function seedDatabase(
  databasePath: string,
  chats: number,
  transcript: ReadonlyArray<{ role: 'user' | 'ai'; text: string; parts: string | null }>
): { chatId: string } {
  const db = new Database(databasePath);
  db.exec('PRAGMA busy_timeout = 10000');
  const userId = (db.query('SELECT id FROM user LIMIT 1').get() as { id: string }).id;
  const now = Date.now();
  const insertChat = db.prepare(
    'INSERT INTO chats (id, title, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, chatId, role, text, timestamp, isGenerating, interactionMode, parts) VALUES (?, ?, ?, ?, ?, 0, 'text', ?)"
  );
  let transcriptChatId = '';
  db.transaction(() => {
    for (let index = 0; index < chats; index += 1) {
      const id = randomUUID();
      const title = `${TITLES[index % TITLES.length]} #${index}`;
      insertChat.run(id, title, now - index * 60_000, now - index * 30_000, userId);
      if (index === 0) transcriptChatId = id;
    }
    transcript.forEach((row, index) => {
      insertMessage.run(randomUUID(), transcriptChatId, row.role, row.text, now + index, row.parts);
    });
  })();
  db.close();
  return { chatId: transcriptChatId };
}

/** What `Response.arrayBuffer()` yields; the Bun codecs take no wider view. */
type Bytes = Uint8Array<ArrayBuffer>;

interface CodecRow {
  readonly codec: string;
  readonly bytes: number;
  readonly compressMs: LatencySummary;
  readonly inflateMs: LatencySummary;
}

function timeOnce(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

function measureCodec(
  codec: string,
  raw: Bytes,
  compress: (input: Bytes) => Uint8Array,
  inflate: ((input: Bytes) => Uint8Array) | null,
  runs: number
): CodecRow {
  const packed = new Uint8Array(compress(raw));
  for (let warm = 0; warm < 3; warm += 1) compress(raw);
  const compressSamples = Array.from({ length: runs }, () => timeOnce(() => compress(raw)));
  const inflateSamples = inflate
    ? Array.from({ length: runs }, () => timeOnce(() => inflate(packed)))
    : [0];
  return {
    codec,
    bytes: packed.byteLength,
    compressMs: summarizeLatencies(compressSamples),
    inflateMs: summarizeLatencies(inflateSamples),
  };
}

export function codecsFor(raw: Bytes, runs: number): CodecRow[] {
  const gzip = (level: 1 | 3 | 6) => (input: Bytes) => Bun.gzipSync(input, { level });
  return [
    measureCodec('gzip-1', raw, gzip(1), (input) => Bun.gunzipSync(input), runs),
    measureCodec('gzip-3', raw, gzip(3), (input) => Bun.gunzipSync(input), runs),
    measureCodec('gzip-6', raw, gzip(6), (input) => Bun.gunzipSync(input), runs),
    measureCodec(
      'zstd-1',
      raw,
      (input) => Bun.zstdCompressSync(input, { level: 1 }),
      (input) => Bun.zstdDecompressSync(input),
      runs
    ),
    measureCodec(
      'zstd-3',
      raw,
      (input) => Bun.zstdCompressSync(input, { level: 3 }),
      (input) => Bun.zstdDecompressSync(input),
      runs
    ),
    measureCodec(
      'br-4 (ref)',
      raw,
      (input) =>
        Uint8Array.from(
          brotliCompressSync(input, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
        ),
      null,
      runs
    ),
  ];
}

interface SizeResult {
  readonly name: string;
  readonly rawBytes: number;
  readonly codecs: CodecRow[];
}

async function runSizes(
  client: HubClient,
  endpoints: readonly Endpoint[],
  runs: number
): Promise<SizeResult[]> {
  const results: SizeResult[] = [];
  for (const endpoint of endpoints) {
    const response = await client.get(endpoint.path, 'identity');
    const type = response.headers.get('content-type') ?? '';
    if (response.status !== 200 || !type.includes('json')) {
      info(`skip ${endpoint.name}: ${response.status} ${type}`);
      continue;
    }
    results.push({
      name: endpoint.name,
      rawBytes: response.body.byteLength,
      codecs: codecsFor(response.body, runs),
    });
  }
  return results;
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function printSizes(results: readonly SizeResult[], runs: number): void {
  header(`Sizes and compress time (n=${runs} per cell; ms are median [p95])`);
  for (const result of results) {
    log(`\n${result.name}: raw ${kb(result.rawBytes)} KB`);
    log('  codec        KB      ratio  compress ms        inflate ms   break-even Mbit/s');
    for (const row of result.codecs) {
      const cost = row.compressMs.median + row.inflateMs.median;
      const breakEven = cost > 0 ? breakEvenMbps(result.rawBytes - row.bytes, cost) : 0;
      log(
        `  ${row.codec.padEnd(11)} ${kb(row.bytes).padStart(7)}  ${(result.rawBytes / row.bytes).toFixed(1).padStart(5)}x  ${`${row.compressMs.median.toFixed(2).padStart(6)} [${row.compressMs.p95.toFixed(2)}]`.padEnd(
          18
        )}${row.inflateMs.median.toFixed(2).padStart(6)}  ${breakEven.toFixed(0).padStart(12)}`
      );
    }
  }
}

/** Own utime + stime of `pid` in seconds, from `/proc`. */
function cpuSeconds(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // Fields after the parenthesised command name; utime and stime are the 14th and 15th overall.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS_PER_SECOND;
}

function firstLanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

interface ServeCase {
  readonly label: string;
  readonly client: HubClient;
  readonly acceptEncoding: string;
}

interface ServeSample {
  readonly latencyMs: number[];
  readonly cpuMsPerRequest: number;
  readonly wireBytes: number;
  readonly contentEncoding: string;
}

async function runServe(
  hub: RunningHub,
  cases: readonly ServeCase[],
  path: string,
  runs: number,
  requests: number
): Promise<Map<string, ServeSample[]>> {
  const samples = new Map<string, ServeSample[]>(cases.map((entry) => [entry.label, []]));
  // One untimed pass per case warms connections and the hub's own caches.
  for (const entry of cases) await entry.client.get(path, entry.acceptEncoding);
  for (let run = 0; run < runs; run += 1) {
    for (const entry of rotatedOrder(cases, run)) {
      const latencyMs: number[] = [];
      let wireBytes = 0;
      let contentEncoding = 'identity';
      const cpuBefore = cpuSeconds(hub.pid);
      for (let request = 0; request < requests; request += 1) {
        const start = performance.now();
        const response = await entry.client.get(path, entry.acceptEncoding);
        latencyMs.push(performance.now() - start);
        if (response.status !== 200) {
          fatal(
            `${entry.label} GET ${path}: expected 200 | received ${response.status}: ${new TextDecoder().decode(response.body).slice(0, 200)}`
          );
        }
        wireBytes = response.body.byteLength;
        contentEncoding = response.headers.get('content-encoding') ?? 'identity';
      }
      const cpuMs = ((cpuSeconds(hub.pid) - cpuBefore) * 1000) / requests;
      samples
        .get(entry.label)
        ?.push({ latencyMs, cpuMsPerRequest: cpuMs, wireBytes, contentEncoding });
    }
  }
  return samples;
}

function printServe(
  samples: Map<string, ServeSample[]>,
  path: string,
  runs: number,
  requests: number
): void {
  header(
    `Hub cost on ${path} (n=${runs} rounds x ${requests} requests; cpu is hub utime+stime per request)`
  );
  log(
    '  case                    wire KB  encoding  latency ms med [p95]      cpu ms/req med [min-max]'
  );
  for (const [label, rounds] of samples) {
    const latency = summarizeLatencies(rounds.flatMap((round) => round.latencyMs));
    const cpu = summarizeLatencies(rounds.map((round) => round.cpuMsPerRequest));
    const last = rounds[rounds.length - 1] as ServeSample;
    log(
      `  ${label.padEnd(22)} ${kb(last.wireBytes).padStart(8)}  ${last.contentEncoding.padEnd(8)}  ${`${latency.median.toFixed(2).padStart(8)} [${latency.p95.toFixed(2)}]`.padEnd(
        26
      )}${cpu.median.toFixed(2)} [${cpu.min.toFixed(2)}-${cpu.max.toFixed(2)}]`
    );
  }
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/api-json-compression.ts <sizes|serve> [options]

  sizes   raw / gzip / zstd / Brotli bytes and compress time per endpoint, with break-even link speed
  serve   hub CPU and latency per request: loopback vs this host's LAN address, identity vs gzip

Options:
  --runs N              Samples per cell (sizes: default 30) or rounds (serve: default 9)
  --requests N          Requests per round and case (serve; default 20). Each address gets 600 requests a minute
                        from the hub's rate limiter, so runs x requests x 2 must stay below that
  --path PATH           Endpoint for serve (default: the 50-message page)
  --chats N             Chats to seed (default 1000)
  --remote-host ADDR    Non-loopback address of this host (default: first external IPv4)
  --hub-dir DIR         Checkout to run the hub from (default: this one)
  --runtime-binary FILE Runtime for runtime-backed endpoints (default: MANGOSTUDIO_RUNTIME_BINARY)
  --home-parent DIR     Parent of the throwaway hub home (default: .mango/bench)
  --json                Machine-readable output (sizes)`);
  process.exit(0);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    booleanFlags: ['--json'],
    valueFlags: [
      '--runs',
      '--requests',
      '--path',
      '--chats',
      '--remote-host',
      '--hub-dir',
      '--runtime-binary',
      '--home-parent',
    ],
  });
  if (parsed.flags['--help']) printHelp();
  const [mode, ...extra] = parsed.positional;
  assertNoUnexpectedArguments(extra);
  if (mode !== 'sizes' && mode !== 'serve')
    fatal(`expected a mode: sizes | serve | received: ${String(mode)}`);

  const positiveInt = (flag: string, fallback: number): number => {
    const value = Number(parsed.values[flag] ?? fallback);
    if (!Number.isInteger(value) || value < 1)
      fatal(`${flag}: expected a positive integer | received ${parsed.values[flag]}`);
    return value;
  };
  const runs = positiveInt('--runs', mode === 'sizes' ? 30 : 9);
  const requests = positiveInt('--requests', 20);
  const chats = positiveInt('--chats', 1000);

  const hub = await startHub({
    hubDir: resolve(parsed.values['--hub-dir'] ?? REPO_ROOT),
    homeParent: resolve(parsed.values['--home-parent'] ?? join(REPO_ROOT, '.mango/bench')),
    runtimeBinary: parsed.values['--runtime-binary'] ?? process.env.MANGOSTUDIO_RUNTIME_BINARY,
  });
  try {
    const loopback = new HubClient(`http://127.0.0.1:${hub.port}`, `http://127.0.0.1:${hub.port}`);
    await loopback.signUp();
    const corpus = await loadCorpus(400);
    const transcript = buildTranscriptRows(corpus, LARGE_PAGE, 0x5eed);
    const { chatId } = seedDatabase(hub.databasePath, chats, transcript);
    const messages = (limit: number) => `/api/chats/${chatId}/messages?limit=${limit}&order=desc`;

    if (mode === 'sizes') {
      const endpoints: Endpoint[] = [
        { name: `messages page, limit=${FRONTEND_PAGE} (frontend)`, path: messages(FRONTEND_PAGE) },
        { name: `messages page, limit=${LARGE_PAGE}`, path: messages(LARGE_PAGE) },
        { name: `chat list, ${chats} chats`, path: '/api/chats/' },
        { name: 'settings: models', path: '/api/settings/models' },
        { name: 'settings: providers', path: '/api/settings/providers' },
        { name: 'settings: tools', path: '/api/settings/tools' },
        { name: 'settings: agents', path: '/api/settings/agents' },
        { name: 'settings: app', path: '/api/settings/app' },
        { name: 'skills', path: '/api/skills' },
        { name: 'library resources', path: '/api/library/resources' },
        { name: 'environments: runtimes', path: '/api/environments/runtimes' },
        { name: 'openapi document', path: '/scalar/json' },
      ];
      const results = await runSizes(loopback, endpoints, runs);
      if (parsed.flags['--json']) log(JSON.stringify({ runs, results }, null, 2));
      else printSizes(results, runs);
      return;
    }

    const remoteHost = parsed.values['--remote-host'] ?? firstLanAddress();
    if (!remoteHost)
      fatal('no non-loopback IPv4 address found | pass --remote-host with an address of this host');
    const remote = loopback.withBase(`http://${remoteHost}:${hub.port}`);
    const path = parsed.values['--path'] ?? messages(FRONTEND_PAGE);
    const cases: ServeCase[] = [
      { label: 'loopback identity', client: loopback, acceptEncoding: 'identity' },
      { label: 'loopback gzip', client: loopback, acceptEncoding: 'gzip, deflate' },
      { label: `remote identity`, client: remote, acceptEncoding: 'identity' },
      { label: `remote gzip`, client: remote, acceptEncoding: 'gzip, deflate' },
    ];
    log(`remote peer address: ${remoteHost}`);
    printServe(await runServe(hub, cases, path, runs, requests), path, runs, requests);
  } finally {
    await hub.stop();
    rmSync(hub.home, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
