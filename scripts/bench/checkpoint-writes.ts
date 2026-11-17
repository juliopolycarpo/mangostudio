#!/usr/bin/env bun

/**
 * Measures what a streaming turn writes to the hub's SQLite files.
 *
 * Every turn checkpoints its assistant row while it streams, so the write
 * volume depends on how the checkpoint is stored, not only on the answer size.
 * This starts a real hub (from source, or a compiled binary) under a throwaway
 * home, points it at a fake OpenAI-compatible provider that streams a fixed
 * answer at a fixed pace, and reports per scenario:
 *
 *   - hub bytes written (`/proc/<pid>/io` `wchar` and `write_bytes`), hub CPU, peak RSS
 *   - with `--counts`, one more pass under `strace`: bytes written to the SQLite main and
 *     `-wal` files, WAL commits and fsyncs. They are exact and do not depend on host load
 *
 * Scenarios: `text-16k-1ms`, `text-16k-20ms`, `text-64k-1ms`, `text-64k-20ms` (4-character
 * chunks, one `chat.completion.chunk` each), `tools-20x65k` (four turns of 20 `read_file`
 * calls with 65 KB results) and `writes-20x65k` (four turns of 20 `write_file` calls of 65 KB
 * each, the tool a hub records as running with a durable write).
 *
 * The hub refuses loopback and private provider addresses (`base-url-policy.ts`), so the fake
 * provider listens on a global IPv6 address of this host (`--provider-host` overrides the
 * detection). It only listens for the duration of the run and requires a random bearer key.
 *
 * Compare two revisions by running the same command with `--hub-dir` set to each checkout.
 *
 * Usage:
 *   bun run scripts/bench/checkpoint-writes.ts --runs 3 --counts
 *   bun run scripts/bench/checkpoint-writes.ts --hub-dir ../base-checkout --scenario tools-20x65k
 *   bun run scripts/bench/checkpoint-writes.ts --hub-binary .mango/out/linux-x64/mangostudio --json
 */

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { type LatencySummary, summarizeLatencies } from '../lib/latency-stats';
import { header, info, log } from '../lib/log';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const MODEL_ID = 'checkpoint-bench-model';
const SETTLE_MS = 500;
const AUTH_SECRET = 'checkpoint-writes-bench-secret-at-least-32-characters';
const TOOL_FIXTURE_FILE = 'fixture.txt';
const TOOL_FINAL_ANSWER_CHARS = 200;
/** One answer: the fake provider's chunk size, matching a model's few-character tokens. */
const CHUNK_CHARS = 4;

export interface Scenario {
  readonly name: string;
  /** Characters of the final streamed answer. */
  readonly answerChars: number;
  /** Pause between provider chunks. */
  readonly chunkDelayMs: number;
  /** Calls to `toolName` the model makes before it answers. */
  readonly toolCalls: number;
  /**
   * The tool the model calls. `read_file` is a plain read; `write_file` changes files, so the
   * hub records each call as running durably (a write the others do not make).
   */
  readonly toolName: 'read_file' | 'write_file';
  /** Size of the file each `read_file` returns, or of the content each `write_file` writes. */
  readonly toolResultChars: number;
  /** Turns per run, each in a fresh chat. */
  readonly turns: number;
}

const textScenario = (name: string, answerChars: number, chunkDelayMs: number): Scenario => ({
  name,
  answerChars,
  chunkDelayMs,
  toolCalls: 0,
  toolName: 'read_file',
  toolResultChars: 0,
  turns: 1,
});

export const SCENARIOS: readonly Scenario[] = [
  textScenario('text-16k-1ms', 16_384, 1),
  textScenario('text-16k-20ms', 16_384, 20),
  textScenario('text-64k-1ms', 65_536, 1),
  textScenario('text-64k-20ms', 65_536, 20),
  {
    name: 'tools-20x65k',
    answerChars: TOOL_FINAL_ANSWER_CHARS,
    chunkDelayMs: 0,
    toolCalls: 20,
    toolName: 'read_file',
    toolResultChars: 65_000,
    turns: 4,
  },
  {
    name: 'writes-20x65k',
    answerChars: TOOL_FINAL_ANSWER_CHARS,
    chunkDelayMs: 0,
    toolCalls: 20,
    toolName: 'write_file',
    toolResultChars: 65_000,
    turns: 4,
  },
];

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible provider
// ---------------------------------------------------------------------------

const FILLER_WORDS = ['alpha', 'bravo', 'delta', 'gamma', 'kilo', 'lima', 'omega', 'sigma'];

/** Deterministic words-and-spaces text of exactly `length` characters. */
export function fillerText(length: number): string {
  let text = '';
  for (let word = 0; text.length < length; word += 1) {
    text += `${FILLER_WORDS[word % FILLER_WORDS.length]} `;
  }
  return text.slice(0, length);
}

/** The scenario rides in the prompt so one provider serves every scenario. */
export function encodeScenarioPrompt(scenario: Scenario): string {
  return (
    `SCENARIO answer=${scenario.answerChars} delay=${scenario.chunkDelayMs} ` +
    `tools=${scenario.toolCalls} tool=${scenario.toolName} size=${scenario.toolResultChars}`
  );
}

export function decodeScenarioPrompt(
  prompt: string
): Pick<
  Scenario,
  'answerChars' | 'chunkDelayMs' | 'toolCalls' | 'toolName' | 'toolResultChars'
> | null {
  const match =
    /SCENARIO answer=(\d+) delay=(\d+) tools=(\d+) tool=(read_file|write_file) size=(\d+)/.exec(
      prompt
    );
  if (!match) return null;
  return {
    answerChars: Number(match[1]),
    chunkDelayMs: Number(match[2]),
    toolCalls: Number(match[3]),
    toolName: match[4] as Scenario['toolName'],
    toolResultChars: Number(match[5]),
  };
}

/** The arguments the fake model gives the scenario's tool for its `index`-th call. */
function toolArguments(
  scenario: Pick<Scenario, 'toolName' | 'toolResultChars'>,
  index: number
): Record<string, unknown> {
  if (scenario.toolName === 'write_file') {
    return { path: `written-${index}.txt`, content: fillerText(scenario.toolResultChars) };
  }
  return { path: TOOL_FIXTURE_FILE };
}

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

function lastUserPrompt(messages: readonly ChatMessage[]): { prompt: string; toolsDone: number } {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  const content = messages[userIndex]?.content;
  const prompt =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: { text?: string }) => part?.text ?? '').join('')
        : '';
  const toolsDone = messages.slice(userIndex + 1).filter((entry) => entry.role === 'tool').length;
  return { prompt, toolsDone };
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The streamed frames for one provider request: a call to the scenario's tool while the scenario
 * still wants tool calls, otherwise the answer in `CHUNK_CHARS` pieces. `pause` is awaited
 * between answer chunks so a caller (or a test) controls the pacing.
 */
export async function* providerFrames(
  request: { readonly model: string; readonly messages: readonly ChatMessage[] },
  pause: (ms: number) => Promise<void>
): AsyncGenerator<string> {
  const { prompt, toolsDone } = lastUserPrompt(request.messages);
  const scenario = decodeScenarioPrompt(prompt) ?? {
    answerChars: TOOL_FINAL_ANSWER_CHARS,
    chunkDelayMs: 0,
    toolCalls: 0,
    toolName: 'read_file' as const,
    toolResultChars: 0,
  };
  const id = `chatcmpl-${randomUUID()}`;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  const usage = (completionTokens: number) =>
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: request.model,
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: completionTokens,
        total_tokens: 10 + completionTokens,
      },
    });

  yield chunk({ role: 'assistant', content: '' }, null);
  if (toolsDone < scenario.toolCalls) {
    yield chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: `call_${toolsDone}_${id.slice(-8)}`,
            type: 'function',
            function: {
              name: scenario.toolName,
              arguments: JSON.stringify(toolArguments(scenario, toolsDone)),
            },
          },
        ],
      },
      null
    );
    yield chunk({}, 'tool_calls');
    yield usage(5);
    yield 'data: [DONE]\n\n';
    return;
  }

  const answer = fillerText(scenario.answerChars);
  for (let offset = 0; offset < answer.length; offset += CHUNK_CHARS) {
    yield chunk({ content: answer.slice(offset, offset + CHUNK_CHARS) }, null);
    if (scenario.chunkDelayMs > 0) await pause(scenario.chunkDelayMs);
  }
  yield chunk({}, 'stop');
  yield usage(Math.ceil(scenario.answerChars / CHUNK_CHARS));
  yield 'data: [DONE]\n\n';
}

export interface FakeProvider {
  readonly baseUrl: string;
  readonly apiKey: string;
  stop(): void;
}

export function startFakeProvider(hostname: string): FakeProvider {
  const apiKey = `fk-${randomUUID()}`;
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname,
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${apiKey}`) {
        return Response.json({ error: { message: 'bad key' } }, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'bench' }],
        });
      }
      if (request.method === 'POST' && path === '/v1/chat/completions') {
        const body = (await request.json()) as {
          model: string;
          messages: ChatMessage[];
          stream?: boolean;
        };
        const frames = providerFrames(body, (ms) => Bun.sleep(ms));
        return new Response(
          new ReadableStream({
            async pull(controller) {
              const next = await frames.next();
              if (next.done) controller.close();
              else controller.enqueue(encoder.encode(next.value));
            },
            cancel() {
              void frames.return(undefined);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }
        );
      }
      return Response.json(
        { error: { message: `unexpected ${request.method} ${path}` } },
        { status: 404 }
      );
    },
  });
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return {
    baseUrl: `http://${host}:${server.port}/v1`,
    apiKey,
    stop: () => void server.stop(true),
  };
}

/** The address the hub's outbound policy accepts: global, and not unique-local. */
export function pickGlobalIpv6(ipAddrOutput: string): string | undefined {
  return [...ipAddrOutput.matchAll(/inet6 ([0-9a-f:]+)\/(\d+)/gi)]
    .map((match) => ({ address: match[1] as string, prefix: Number(match[2]) }))
    .filter(({ address }) => !/^f[cd]/i.test(address))
    .sort((left, right) => right.prefix - left.prefix)[0]?.address;
}

// ---------------------------------------------------------------------------
// /proc readings
// ---------------------------------------------------------------------------

export interface ProcReading {
  readonly wcharBytes: number;
  readonly writeBytes: number;
  readonly cpuMs: number;
  readonly peakRssKb: number;
}

export function parseProcIo(io: string): { wcharBytes: number; writeBytes: number } {
  const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)`, 'm').exec(io)?.[1]);
  const wcharBytes = field('wchar');
  const writeBytes = field('write_bytes');
  if (Number.isNaN(wcharBytes) || Number.isNaN(writeBytes)) {
    throw new Error(
      `(/proc/<pid>/io): expected wchar and write_bytes lines | received: ${io.slice(0, 200)}`
    );
  }
  return { wcharBytes, writeBytes };
}

function readProc(pid: number): ProcReading {
  const { wcharBytes, writeBytes } = parseProcIo(readFileSync(`/proc/${pid}/io`, 'utf8'));
  let cpuNs = 0;
  for (const task of readdirSync(`/proc/${pid}/task`)) {
    try {
      cpuNs += Number(readFileSync(`/proc/${pid}/task/${task}/schedstat`, 'utf8').split(' ')[0]);
    } catch {
      // The thread exited between the listing and the read.
    }
  }
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return {
    wcharBytes,
    writeBytes,
    cpuMs: cpuNs / 1e6,
    peakRssKb: Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0),
  };
}

/** Resets `VmHWM` to the current RSS so the next reading is the following turn's peak. */
function resetPeakRss(pid: number): void {
  try {
    writeFileSync(`/proc/${pid}/clear_refs`, '5');
  } catch {
    // Peak RSS then covers the whole run; the report says so by showing the same value.
  }
}

// ---------------------------------------------------------------------------
// strace: SQLite bytes, commits and fsyncs
// ---------------------------------------------------------------------------

export interface SqliteWriteCounts {
  readonly walBytes: number;
  readonly mainBytes: number;
  /** WAL transactions: frames whose header names a database size. */
  readonly commits: number;
  readonly walFsyncs: number;
  readonly mainFsyncs: number;
}

export interface TimeWindow {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

const WAL_FRAME_HEADER_BYTES = 24;
const STRACE_WRITE =
  /^(?:\[pid\s+\d+\]\s+|\d+\s+)?(\d+\.\d+)\s+pwrite64\(\d+<([^>]+)>, "([^"]*)"(?:\.\.\.)?, (\d+), \d+\)/;
const STRACE_SYNC = /^(?:\[pid\s+\d+\]\s+|\d+\s+)?(\d+\.\d+)\s+f(?:data)?sync\(\d+<([^>]+)>/;

/** `-xx` prints every byte of a path and of the data as `\xNN`. */
function decodeStraceHex(escaped: string): string {
  return escaped.replace(/\\x([0-9a-f]{2})/gi, (_, byte: string) =>
    String.fromCharCode(Number.parseInt(byte, 16))
  );
}

/**
 * Counts SQLite file writes in a `strace -f -ttt -y -xx -s 8 -e trace=pwrite64,fsync,fdatasync`
 * log, for the syscalls that started inside `window`. A WAL frame is a 24-byte header
 * write followed by a page write; the header's bytes 4-8 are the database size in pages
 * and are non-zero only on a transaction's last frame.
 */
export function countSqliteWrites(
  straceLog: string,
  databaseFile: string,
  window: TimeWindow
): SqliteWriteCounts {
  const walFile = `${databaseFile}-wal`;
  let walBytes = 0;
  let mainBytes = 0;
  let commits = 0;
  let walFsyncs = 0;
  let mainFsyncs = 0;
  for (const line of straceLog.split('\n')) {
    const write = STRACE_WRITE.exec(line);
    const sync = write ? null : STRACE_SYNC.exec(line);
    const match = write ?? sync;
    if (!match) continue;
    const seconds = Number(match[1]);
    if (seconds < window.startSeconds || seconds > window.endSeconds) continue;
    const path = decodeStraceHex(match[2] as string);
    if (path !== databaseFile && path !== walFile) continue;
    if (sync) {
      if (path === walFile) walFsyncs += 1;
      else mainFsyncs += 1;
      continue;
    }
    const bytes = Number(match[4]);
    if (path === databaseFile) {
      mainBytes += bytes;
      continue;
    }
    walBytes += bytes;
    if (bytes === WAL_FRAME_HEADER_BYTES) {
      const header = (match[3] as string).match(/\\x[0-9a-f]{2}/gi) ?? [];
      if (header.slice(4, 8).some((byte) => byte.toLowerCase() !== '\\x00')) commits += 1;
    }
  }
  return { walBytes, mainBytes, commits, walFsyncs, mainFsyncs };
}

// ---------------------------------------------------------------------------
// Hub and client
// ---------------------------------------------------------------------------

interface HubOptions {
  readonly hubDir: string;
  readonly hubBinary: string | undefined;
  readonly homeParent: string;
  readonly runtimeBinary: string | undefined;
  readonly trace: boolean;
}

interface RunningHub {
  readonly pid: number;
  readonly base: string;
  readonly home: string;
  readonly databasePath: string;
  readonly traceLog: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function startHub(options: HubOptions): Promise<RunningHub> {
  mkdirSync(options.homeParent, { recursive: true });
  const home = mkdtempSync(join(options.homeParent, 'hub-'));
  const port = await freePort();
  const databasePath = join(home, 'database.sqlite');
  const traceLog = join(home, 'strace.log');
  const hubArgv = options.hubBinary
    ? [options.hubBinary, 'serve', String(port)]
    : ['bun', join(options.hubDir, 'apps/api/src/index.ts'), 'serve', String(port)];
  const argv = options.trace
    ? [
        'strace',
        '-f',
        '-ttt',
        '-y',
        '-xx',
        '-s',
        '8',
        '-o',
        traceLog,
        '-e',
        'trace=pwrite64,fsync,fdatasync',
        ...hubArgv,
      ]
    : hubArgv;
  const output = openSync(join(home, 'hub.log'), 'a');
  const child = Bun.spawn(argv, {
    cwd: options.hubDir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'production',
      MANGO_HOME: home,
      API_PORT: String(port),
      API_HOST: '127.0.0.1',
      AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      DATABASE_PATH: databasePath,
      UPLOADS_DIR: join(home, 'uploads'),
      IMAGES_DIR: join(home, 'images'),
      TOOL_IMAGES_DIR: join(home, 'tool-images'),
      MANGOSTUDIO_DIAGNOSTIC_LOGS: '0',
      ...(options.runtimeBinary ? { MANGOSTUDIO_RUNTIME_BINARY: options.runtimeBinary } : {}),
    },
    stdin: 'ignore',
    stdout: output,
    stderr: output,
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) break;
    } catch {
      // Still starting.
    }
    await Bun.sleep(50);
  }
  if (child.exitCode !== null || performance.now() >= deadline) {
    child.kill('SIGKILL');
    fatal(`hub did not become healthy within 120 s; see ${join(home, 'hub.log')}`);
  }
  // Under strace the hub is strace's child: measure and stop the tracee, not the tracer.
  const hubPid = options.trace ? tracedChildPid(child.pid) : child.pid;
  return {
    pid: hubPid,
    base,
    home,
    databasePath,
    traceLog,
    async stop() {
      try {
        process.kill(hubPid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(30_000).then(() => false),
      ]);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

function tracedChildPid(tracerPid: number): number {
  const out = Bun.spawnSync(['pgrep', '-P', String(tracerPid)])
    .stdout.toString()
    .trim();
  const pid = Number(out.split('\n')[0]);
  if (!pid)
    fatal(`strace (pid ${tracerPid}) has no traced hub child | received pgrep output: ${out}`);
  return pid;
}

class HubClient {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Origin: this.base,
      Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      ...extra,
    };
  }

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = (line.split(';')[0] as string).trim();
      const equals = pair.indexOf('=');
      this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    const text = await response.text();
    if (!response.ok) {
      fatal(`${method} ${path}: expected 2xx | received ${response.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

async function configureHub(client: HubClient, provider: FakeProvider): Promise<void> {
  await client.call('POST', '/api/auth/sign-up/email', {
    email: 'bench@example.test',
    password: 'checkpoint-bench-password-123',
    name: 'Bench',
  });
  const connector = (await client.call('POST', '/api/settings/connectors', {
    name: 'checkpoint-bench',
    apiKey: provider.apiKey,
    source: 'config-file',
    provider: 'openai-compatible',
    baseUrl: provider.baseUrl,
  })) as { id: string };
  await client.call('PUT', `/api/settings/connectors/${connector.id}/models`, {
    enabledModels: [MODEL_ID],
  });
  const agent = (await client.call('GET', '/api/settings/agents/default')) as Record<
    string,
    unknown
  >;
  await client.call('PUT', '/api/settings/agents/default', {
    name: agent.name,
    description: agent.description,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    thinkingEnabled: false,
    reasoningEffort: agent.reasoningEffort,
    maxToolIterations: 200,
    toolNames: ['read_file', 'write_file'],
    toolsEnabled: true,
    subagentIds: [],
    metadata: agent.metadata ?? {},
  });
}

interface TurnOutcome {
  readonly ok: boolean;
  readonly wallMs: number;
  readonly answerChars: number;
  readonly toolResults: number;
  readonly detail: string;
}

async function streamTurn(
  client: HubClient,
  chatId: string,
  scenario: Scenario
): Promise<TurnOutcome> {
  const startedAt = performance.now();
  const response = await fetch(`${client.base}/api/respond/stream`, {
    method: 'POST',
    headers: client.headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      chatId,
      prompt: encodeScenarioPrompt(scenario),
      model: MODEL_ID,
      thinkingEnabled: false,
    }),
  });
  if (!response.ok || !response.body) {
    return {
      ok: false,
      wallMs: performance.now() - startedAt,
      answerChars: 0,
      toolResults: 0,
      detail: `http ${response.status}: ${(await response.text()).slice(0, 300)}`,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let answerChars = 0;
  let toolResults = 0;
  let terminal = 'eof';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6)) as { type: string; text?: string };
      if (event.type === 'text') answerChars += event.text?.length ?? 0;
      else if (event.type === 'tool_result') toolResults += 1;
      else if (event.type === 'done') terminal = 'done';
      else if (event.type === 'error') terminal = `error ${frame.slice(0, 300)}`;
    }
  }
  return {
    ok:
      terminal === 'done' &&
      answerChars === scenario.answerChars &&
      toolResults === scenario.toolCalls,
    wallMs: performance.now() - startedAt,
    answerChars,
    toolResults,
    detail: `terminal=${terminal} answerChars=${answerChars} toolResults=${toolResults}`,
  };
}

// ---------------------------------------------------------------------------
// Runs and report
// ---------------------------------------------------------------------------

interface TurnMeasure {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly wcharBytes: number;
  readonly writeBytes: number;
  readonly peakRssKb: number;
}

interface ScenarioRun {
  readonly scenario: string;
  readonly turns: readonly TurnMeasure[];
  /** Present on traced runs: counts summed over the scenario's turns. */
  readonly counts?: SqliteWriteCounts;
}

async function writeToolFixture(directory: string, chars: number): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const line = `${'x'.repeat(79)}\n`;
  await Bun.write(
    join(directory, TOOL_FIXTURE_FILE),
    line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
  );
}

async function runScenarios(
  scenarios: readonly Scenario[],
  options: HubOptions,
  providerHost: string
): Promise<ScenarioRun[]> {
  const provider = startFakeProvider(providerHost);
  const hub = await startHub(options);
  const results: ScenarioRun[] = [];
  const windows = new Map<string, { startSeconds: number; endSeconds: number }>();
  try {
    const client = new HubClient(hub.base);
    await configureHub(client, provider);
    for (const scenario of scenarios) {
      const workdir = join(hub.home, 'workdir');
      if (scenario.toolCalls > 0) await writeToolFixture(workdir, scenario.toolResultChars);
      const turns: TurnMeasure[] = [];
      const startSeconds = Date.now() / 1000;
      for (let turn = 0; turn < scenario.turns; turn += 1) {
        const chat = (await client.call('POST', '/api/chats', {
          title: scenario.name,
          model: MODEL_ID,
        })) as {
          id: string;
        };
        if (scenario.toolCalls > 0) await client.call('PUT', `/api/chats/${chat.id}`, { workdir });
        resetPeakRss(hub.pid);
        const before = readProc(hub.pid);
        const outcome = await streamTurn(client, chat.id, scenario);
        // Thrown, not `fatal`: process.exit would skip the `finally` that stops the hub and provider.
        if (!outcome.ok) {
          throw new Error(
            `${scenario.name} turn ${turn + 1}: expected the full answer and every tool result | received ${outcome.detail}`
          );
        }
        // Trailing checkpoint and finalize writes count toward the turn.
        await Bun.sleep(SETTLE_MS);
        const after = readProc(hub.pid);
        turns.push({
          wallMs: outcome.wallMs,
          cpuMs: after.cpuMs - before.cpuMs,
          wcharBytes: after.wcharBytes - before.wcharBytes,
          writeBytes: after.writeBytes - before.writeBytes,
          peakRssKb: after.peakRssKb,
        });
      }
      windows.set(scenario.name, { startSeconds, endSeconds: Date.now() / 1000 });
      results.push({ scenario: scenario.name, turns });
    }
  } finally {
    await hub.stop();
    provider.stop();
  }
  if (!options.trace) {
    rmSync(hub.home, { recursive: true, force: true });
    return results;
  }
  const straceLog = readFileSync(hub.traceLog, 'utf8');
  rmSync(hub.home, { recursive: true, force: true });
  return results.map((result) => ({
    ...result,
    counts: countSqliteWrites(
      straceLog,
      hub.databasePath,
      windows.get(result.scenario) as TimeWindow
    ),
  }));
}

export interface ScenarioSummary {
  readonly scenario: string;
  readonly runs: number;
  readonly turnsPerRun: number;
  readonly perTurn: {
    readonly wallMs: LatencySummary;
    readonly cpuMs: LatencySummary;
    readonly wcharMiB: LatencySummary;
    readonly writeMiB: LatencySummary;
    readonly peakRssMiB: LatencySummary;
  };
  readonly counts?: {
    readonly sqliteMiB: LatencySummary;
    readonly commits: LatencySummary;
    readonly walFsyncs: LatencySummary;
  };
}

const MIB = 1024 * 1024;

/** Per-turn samples pooled over runs; traced counts are per scenario run, so divided by turns. */
export function summarizeScenario(runs: readonly ScenarioRun[]): ScenarioSummary {
  const turns = runs.flatMap((run) => run.turns);
  const turnsPerRun = (runs[0]?.turns.length ?? 1) || 1;
  const traced = runs.flatMap((run) => (run.counts ? [run.counts] : []));
  const perTurnCount = (pick: (counts: SqliteWriteCounts) => number) =>
    summarizeLatencies(traced.map((counts) => pick(counts) / turnsPerRun));
  return {
    scenario: runs[0]?.scenario ?? '',
    runs: runs.length,
    turnsPerRun,
    perTurn: {
      wallMs: summarizeLatencies(turns.map((turn) => turn.wallMs)),
      cpuMs: summarizeLatencies(turns.map((turn) => turn.cpuMs)),
      wcharMiB: summarizeLatencies(turns.map((turn) => turn.wcharBytes / MIB)),
      writeMiB: summarizeLatencies(turns.map((turn) => turn.writeBytes / MIB)),
      peakRssMiB: summarizeLatencies(turns.map((turn) => turn.peakRssKb / 1024)),
    },
    ...(traced.length > 0
      ? {
          counts: {
            sqliteMiB: summarizeLatencies(
              traced.map((counts) => (counts.walBytes + counts.mainBytes) / MIB / turnsPerRun)
            ),
            commits: perTurnCount((counts) => counts.commits),
            walFsyncs: perTurnCount((counts) => counts.walFsyncs),
          },
        }
      : {}),
  };
}

/**
 * Timing comes from the untraced runs, counts from the traced ones. A run without
 * `--counts` has no traced runs, and summarizing an empty list throws on its empty
 * timing samples, so the traced half is only summarized when it exists.
 */
export function summarizeTimedAndTracedRuns(
  timedRuns: readonly ScenarioRun[],
  tracedRuns: readonly ScenarioRun[]
): ScenarioSummary {
  const timed = summarizeScenario(timedRuns);
  if (tracedRuns.length === 0) return timed;
  const { counts } = summarizeScenario(tracedRuns);
  return counts ? { ...timed, counts } : timed;
}

const spread = (summary: LatencySummary, digits = 1) =>
  `${summary.median.toFixed(digits)} (${summary.min.toFixed(digits)}-${summary.max.toFixed(digits)})`;

export function formatSummaryRow(summary: ScenarioSummary): string {
  const counts = summary.counts;
  return [
    summary.scenario,
    `${summary.runs}x${summary.turnsPerRun}`,
    spread(summary.perTurn.wallMs, 0),
    spread(summary.perTurn.cpuMs, 0),
    spread(summary.perTurn.wcharMiB, 2),
    spread(summary.perTurn.writeMiB, 2),
    spread(summary.perTurn.peakRssMiB, 0),
    counts ? spread(counts.sqliteMiB, 2) : '-',
    counts ? spread(counts.commits, 0) : '-',
    counts ? spread(counts.walFsyncs, 0) : '-',
  ].join(' | ');
}

const TABLE_HEADER =
  'scenario | runs x turns | wall ms | hub cpu ms | wchar MiB | write_bytes MiB | peak RSS MiB | sqlite MiB | commits | wal fsyncs';

function printHelp(): never {
  log(`Usage: bun run scripts/bench/checkpoint-writes.ts [--scenario a,b] [--runs N] [--counts] [--json]
       [--hub-dir DIR | --hub-binary FILE] [--runtime-binary FILE] [--provider-host ADDR] [--home-parent DIR]

  --scenario LIST       Comma-separated subset of: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}
  --runs N              Fresh hubs per measurement (default 3); every run measures every scenario
  --counts              Add one run per repetition under strace: SQLite bytes, commits, WAL fsyncs
  --hub-dir DIR         Checkout whose hub is run from source (default: this checkout)
  --hub-binary FILE     Run a compiled hub instead of the source
  --runtime-binary FILE Runtime for tool turns (default: MANGOSTUDIO_RUNTIME_BINARY)
  --provider-host ADDR  Address the fake provider listens on (default: a global IPv6 address)
  --home-parent DIR     Where hub homes are created (default: .mango/bench; use a disk, not tmpfs)
  --json                Print only the JSON result
  --help                Show this help message`);
  process.exit(0);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    booleanFlags: ['--counts', '--json'],
    valueFlags: [
      '--scenario',
      '--runs',
      '--hub-dir',
      '--hub-binary',
      '--runtime-binary',
      '--provider-host',
      '--home-parent',
    ],
    selectionFlags: [],
  });
  if (parsed.flags['--help']) printHelp();
  assertNoUnexpectedArguments(parsed.positional);

  const names = parsed.values['--scenario']?.split(',').filter(Boolean);
  const scenarios = names
    ? names.map((name) => {
        const found = SCENARIOS.find((scenario) => scenario.name === name);
        return (
          found ??
          fatal(
            `unknown scenario "${name}" | expected one of: ${SCENARIOS.map((s) => s.name).join(', ')}`
          )
        );
      })
    : SCENARIOS;
  const runs = Number(parsed.values['--runs'] ?? 3);
  if (!Number.isInteger(runs) || runs < 1)
    fatal(`--runs: expected a positive integer | received ${parsed.values['--runs']}`);

  const providerHost =
    parsed.values['--provider-host'] ??
    pickGlobalIpv6(
      Bun.spawnSync(['ip', '-6', '-o', 'addr', 'show', 'scope', 'global']).stdout.toString()
    );
  if (!providerHost) {
    fatal(
      'the hub refuses loopback and private provider addresses and this host has no global IPv6 address | pass --provider-host with a public address of this host'
    );
  }
  const counts = parsed.flags['--counts'] === true;
  if (counts && !Bun.which('strace')) fatal('--counts needs strace on PATH');
  const hubDir = resolve(parsed.values['--hub-dir'] ?? REPO_ROOT);
  const base: Omit<HubOptions, 'trace'> = {
    hubDir,
    hubBinary: parsed.values['--hub-binary'] ? resolve(parsed.values['--hub-binary']) : undefined,
    homeParent: resolve(parsed.values['--home-parent'] ?? join(REPO_ROOT, '.mango/bench')),
    runtimeBinary: parsed.values['--runtime-binary'] ?? process.env.MANGOSTUDIO_RUNTIME_BINARY,
  };
  if (scenarios.some((scenario) => scenario.toolCalls > 0) && !base.runtimeBinary) {
    fatal('tool scenarios need a runtime: set MANGOSTUDIO_RUNTIME_BINARY or pass --runtime-binary');
  }

  const loadStart = loadavg()[0] as number;
  const timed: ScenarioRun[][] = [];
  const traced: ScenarioRun[][] = [];
  for (let run = 0; run < runs; run += 1) {
    if (!parsed.flags['--json']) info(`run ${run + 1}/${runs}: timed`);
    timed.push(await runScenarios(scenarios, { ...base, trace: false }, providerHost));
    if (counts) {
      if (!parsed.flags['--json']) info(`run ${run + 1}/${runs}: strace`);
      traced.push(await runScenarios(scenarios, { ...base, trace: true }, providerHost));
    }
  }
  const loadEnd = loadavg()[0] as number;

  const summaries = scenarios.map((scenario) => {
    const timedRuns = timed.map(
      (run) => run.find((entry) => entry.scenario === scenario.name) as ScenarioRun
    );
    const tracedRuns = traced.map(
      (run) => run.find((entry) => entry.scenario === scenario.name) as ScenarioRun
    );
    return summarizeTimedAndTracedRuns(timedRuns, tracedRuns);
  });
  const result = {
    hub: base.hubBinary ?? `${hubDir} (source)`,
    runs,
    loadavg1mStart: loadStart,
    loadavg1mEnd: loadEnd,
    summaries,
  };
  if (parsed.flags['--json']) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  header(`hub: ${result.hub} | 1-minute load ${loadStart.toFixed(1)} -> ${loadEnd.toFixed(1)}`);
  log('median (min-max) per turn');
  log(TABLE_HEADER);
  for (const summary of summaries) log(formatSummaryRow(summary));
}

if (import.meta.main) await main();
