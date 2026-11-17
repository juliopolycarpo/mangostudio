#!/usr/bin/env bun

/**
 * Measures the frontend's per-chunk streaming path in-process: the text
 * generation stream reducer, then the patch that writes its update into the
 * transcript cache, for a stream of N chunks of about 40 characters.
 *
 * Three streams: assistant `text`, `thinking` (reasoning) and `subagent_text`.
 * For each size it reports total time, the mean cost of the first and the last
 * 50 chunks (the ratio is the growth: about 1 is linear in the stream, more is
 * superlinear), the heap the finished state retains, and how many objects change
 * identity on one more chunk at the end of the stream: the cache, the newest
 * page, its message array, the live message, its parts and the sibling
 * messages. Siblings and older pages that change identity defeat `memo` rows.
 *
 * The reducer comes from a checkout's `apps/frontend`, so a base and a head
 * checkout run the same scenarios. A checkout without
 * `message-cache-patch.ts` is measured with the updater `useOptimisticMessages`
 * ran before that module existed (`legacyPatchMessageInCache`).
 *
 * Usage:
 *   bun run scripts/bench/stream-reducer.ts [--frontend-dir apps/frontend] [--runs N]
 *     [--kind text,thinking,subagent_text] [--chunks 500,2000,8000] [--history N] [--json]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { log } from '../lib/log';

export const STREAM_KINDS = ['text', 'thinking', 'subagent_text'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

const DEFAULT_CHUNK_COUNTS = [500, 2000, 8000] as const;
const WINDOW = 50;
const SUBAGENT_CALL_ID = 'call-subagent-1';
const LIVE_MESSAGE_ID = 'message-live';

/** About 40 characters, like a short model token run. */
const CHUNK_TEXT = 'The quick brown fox jumps over lazy dogs. '.slice(0, 40);

interface BenchedMessage {
  readonly id: string;
  readonly parts?: readonly unknown[];
  readonly [key: string]: unknown;
}
interface BenchedPage {
  readonly messages: readonly BenchedMessage[];
  readonly [key: string]: unknown;
}
export interface BenchedCache {
  readonly pages: readonly BenchedPage[];
  readonly pageParams: readonly unknown[];
}
interface BenchedUpdate {
  readonly targetMessageId: string;
  readonly patch: Record<string, unknown>;
}
interface BenchedState {
  readonly aiMessageUpdate: BenchedUpdate | null;
}

export interface StreamModules {
  readonly createState: (ids: { userMessageId: string; aiMessageId: string }) => BenchedState;
  readonly reduce: (
    state: BenchedState,
    chunk: Record<string, unknown>,
    options: { pendingSubagentName: string }
  ) => BenchedState;
  readonly patch: (
    cache: BenchedCache,
    messageId: string,
    updates: Record<string, unknown>
  ) => BenchedCache;
  readonly patchSource: 'module' | 'legacy';
  /** Where the patched cache lives: the app's own query client, or a plain variable. */
  readonly openStore: (history: number, sharing: StructuralSharing) => CacheStore;
}

/** How the transcript query merges written data: the app's default, or switched off. */
export type StructuralSharing = 'app' | 'off';

/** The transcript cache as a stream writes it: one patch per chunk, read back as a whole. */
export interface CacheStore {
  read(): BenchedCache;
  write(messageId: string, updates: Record<string, unknown>): void;
  close(): void;
}

/** A store that is just a variable, for tests and for measuring the patch without a query client. */
export function createPlainStore(patch: StreamModules['patch'], history: number): CacheStore {
  let cache = seedCache(history);
  return {
    read: () => cache,
    write: (messageId, updates) => {
      cache = patch(cache, messageId, updates);
    },
    close: () => undefined,
  };
}

/** The chunks a turn of `kind` streams after its opening chunk, `count` of them. */
export function buildChunks(kind: StreamKind, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () =>
    kind === 'subagent_text'
      ? { type: kind, callId: SUBAGENT_CALL_ID, text: CHUNK_TEXT }
      : { type: kind, text: CHUNK_TEXT }
  );
}

function openingChunks(kind: StreamKind): Record<string, unknown>[] {
  if (kind === 'subagent_text') {
    return [
      {
        type: 'subagent_started',
        callId: SUBAGENT_CALL_ID,
        agentId: 'agent-1',
        agentName: 'Researcher',
        task: 'Look it up',
      },
    ];
  }
  return kind === 'thinking' ? [{ type: 'thinking_start' }] : [];
}

/**
 * Settled history above the live turn: `history` rows on the newest page and as
 * many on one older page, so an updater that rebuilds every page shows up.
 */
export function seedCache(history: number): BenchedCache {
  const settled = (prefix: string, index: number): BenchedMessage => ({
    id: `${prefix}-${index}`,
    role: index % 2 === 0 ? 'user' : 'ai',
    text: `settled ${prefix} ${index}`,
    parts: [{ type: 'text', text: `settled ${prefix} ${index}` }],
  });
  const newest = [
    ...Array.from({ length: history }, (_, index) => settled('newest', index)),
    { id: LIVE_MESSAGE_ID, role: 'ai', text: '', parts: [], isGenerating: true },
  ];
  const older = Array.from({ length: history }, (_, index) => settled('older', index));
  return {
    pages: [
      { messages: newest, nextCursor: 'cursor-0' },
      { messages: older, nextCursor: null },
    ],
    pageParams: [null, 'cursor-0'],
  };
}

/**
 * The updater `useOptimisticMessages` ran for every chunk before
 * `message-cache-patch.ts` existed: every page and every row mapped.
 */
export function legacyPatchMessageInCache(
  cache: BenchedCache,
  messageId: string,
  updates: Record<string, unknown>
): BenchedCache {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
    })),
  };
}

export interface IdentityChanges {
  readonly cache: number;
  readonly pages: number;
  readonly newestPageMessages: number;
  readonly liveMessage: number;
  readonly liveMessageParts: number;
  readonly siblingMessages: number;
  readonly olderPageMessages: number;
}

/** How many of each object `after` replaced, counted against `before` by `===`. */
export function countIdentityChanges(before: BenchedCache, after: BenchedCache): IdentityChanges {
  const isNew = (a: unknown, b: unknown) => (a === b ? 0 : 1);
  let siblingMessages = 0;
  let olderPageMessages = 0;
  let liveMessage = 0;
  let liveMessageParts = 0;
  let pages = 0;
  before.pages.forEach((page, pageIndex) => {
    const nextPage = after.pages[pageIndex];
    pages += isNew(page, nextPage);
    page.messages.forEach((message, messageIndex) => {
      const nextMessage = nextPage?.messages[messageIndex];
      if (message.id === LIVE_MESSAGE_ID) {
        liveMessage += isNew(message, nextMessage);
        liveMessageParts += isNew(message.parts, nextMessage?.parts);
      } else if (pageIndex === 0) {
        siblingMessages += isNew(message, nextMessage);
      } else {
        olderPageMessages += isNew(message, nextMessage);
      }
    });
  });
  return {
    cache: isNew(before, after),
    pages,
    newestPageMessages: isNew(before.pages[0]?.messages, after.pages[0]?.messages),
    liveMessage,
    liveMessageParts,
    siblingMessages,
    olderPageMessages,
  };
}

export interface StreamRun {
  readonly totalMs: number;
  readonly reducerOnlyMs: number;
  readonly firstUsPerChunk: number;
  readonly lastUsPerChunk: number;
  readonly retainedHeapMiB: number;
  readonly identity: IdentityChanges;
}

function applyChunk(
  modules: StreamModules,
  state: BenchedState,
  store: CacheStore,
  chunk: Record<string, unknown>
): BenchedState {
  const nextState = modules.reduce(state, chunk, { pendingSubagentName: 'Subagent' });
  const update = nextState.aiMessageUpdate;
  if (update) store.write(update.targetMessageId, update.patch);
  return nextState;
}

/** One pass: the whole stream through reducer and cache write, timed per chunk. */
export function runStream(
  modules: StreamModules,
  kind: StreamKind,
  chunkCount: number,
  history: number,
  sharing: StructuralSharing = 'app'
): StreamRun {
  const options = { userMessageId: 'message-user', aiMessageId: LIVE_MESSAGE_ID };
  const start = (): { state: BenchedState; store: CacheStore } => {
    let state = modules.createState(options);
    const store = modules.openStore(history, sharing);
    for (const chunk of openingChunks(kind)) state = applyChunk(modules, state, store, chunk);
    return { state, store };
  };
  const chunks = buildChunks(kind, chunkCount + 1);
  const finalChunk = chunks.pop() as Record<string, unknown>;

  // Reducer alone, to separate its cost from the cache write.
  const reducerRun = start();
  let reducerState = reducerRun.state;
  reducerRun.store.close();
  const reducerStartedAt = Bun.nanoseconds();
  for (const chunk of chunks) {
    reducerState = modules.reduce(reducerState, chunk, { pendingSubagentName: 'Subagent' });
  }
  const reducerOnlyMs = (Bun.nanoseconds() - reducerStartedAt) / 1e6;

  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const run = start();
  let state = run.state;
  const durationsNs: number[] = [];
  const startedAt = Bun.nanoseconds();
  for (const chunk of chunks) {
    const chunkStartedAt = Bun.nanoseconds();
    state = applyChunk(modules, state, run.store, chunk);
    durationsNs.push(Bun.nanoseconds() - chunkStartedAt);
  }
  const totalMs = (Bun.nanoseconds() - startedAt) / 1e6;
  Bun.gc(true);
  const retainedHeapMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

  const meanUs = (window: readonly number[]) =>
    window.reduce((sum, ns) => sum + ns, 0) / window.length / 1e3;
  const windowSize = Math.min(WINDOW, durationsNs.length);
  const before = run.store.read();
  applyChunk(modules, state, run.store, finalChunk);
  const identity = countIdentityChanges(before, run.store.read());
  run.store.close();
  return {
    totalMs,
    reducerOnlyMs,
    firstUsPerChunk: meanUs(durationsNs.slice(0, windowSize)),
    lastUsPerChunk: meanUs(durationsNs.slice(-windowSize)),
    retainedHeapMiB,
    identity,
  };
}

export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

async function loadModules(frontendDir: string): Promise<StreamModules> {
  const generationDir = resolve(frontendDir, 'src/features/generation');
  const reducerPath = resolve(generationDir, 'text-generation-stream-reducer.ts');
  if (!existsSync(reducerPath)) {
    fatal(`expected a checkout's apps/frontend | received: ${frontendDir} (no ${reducerPath})`);
  }
  const reducer = (await import(reducerPath)) as {
    createTextGenerationStreamState: StreamModules['createState'];
    reduceTextGenerationStreamChunk: StreamModules['reduce'];
  };
  const patchPath = resolve(generationDir, 'message-cache-patch.ts');
  const patchModule = existsSync(patchPath)
    ? ((await import(patchPath)) as {
        patchMessageInCache: (
          cache: BenchedCache | undefined,
          messageId: string,
          updates: Record<string, unknown>
        ) => BenchedCache | undefined;
      })
    : null;
  const patch: StreamModules['patch'] = patchModule
    ? (cache, messageId, updates) =>
        patchModule.patchMessageInCache(cache, messageId, updates) as BenchedCache
    : legacyPatchMessageInCache;

  // The app's own client and transcript query options, with one observer
  // subscribed like the open chat's `useInfiniteQuery`. A write then pays what
  // the app pays: the updater, structural sharing, the cache event fan-out
  // (including the capability-invalidation subscriber) and the observer result.
  const frontendSrc = resolve(frontendDir, 'src');
  const { queryClient } = (await import(resolve(frontendSrc, 'lib/query-client.ts'))) as {
    queryClient: QueryClientLike;
  };
  const { messagesQueryOptions } = (await import(
    resolve(frontendSrc, 'features/chat/queries.ts')
  )) as {
    messagesQueryOptions: (chatId: string) => { queryKey: readonly unknown[] };
  };
  const { InfiniteQueryObserver } = (await import(
    Bun.resolveSync('@tanstack/react-query', frontendDir)
  )) as { InfiniteQueryObserver: new (client: QueryClientLike, options: unknown) => ObserverLike };
  let storeCount = 0;
  const openStore = (history: number, sharing: StructuralSharing): CacheStore => {
    storeCount += 1;
    const queryOptions = {
      ...messagesQueryOptions(`chat-bench-${storeCount}`),
      // Seeded data is fresh for the whole pass, so subscribing starts no fetch.
      staleTime: Number.POSITIVE_INFINITY,
      ...(sharing === 'off' ? { structuralSharing: false } : {}),
    };
    queryClient.setQueryData(queryOptions.queryKey, seedCache(history));
    const observer = new InfiniteQueryObserver(queryClient, queryOptions);
    const unsubscribe = observer.subscribe(() => undefined);
    return {
      read: () => queryClient.getQueryData(queryOptions.queryKey) as BenchedCache,
      write: (messageId, updates) => {
        queryClient.setQueryData(queryOptions.queryKey, (old: BenchedCache | undefined) =>
          old ? patch(old, messageId, updates) : old
        );
      },
      close: () => {
        unsubscribe();
        queryClient.removeQueries({ queryKey: queryOptions.queryKey });
      },
    };
  };
  return {
    createState: reducer.createTextGenerationStreamState,
    reduce: reducer.reduceTextGenerationStreamChunk,
    patch,
    patchSource: patchModule ? 'module' : 'legacy',
    openStore,
  };
}

interface QueryClientLike {
  setQueryData(key: readonly unknown[], updater: unknown): unknown;
  getQueryData(key: readonly unknown[]): unknown;
  removeQueries(filters: { queryKey: readonly unknown[] }): void;
}
interface ObserverLike {
  subscribe(listener: () => void): () => void;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printHelp(): never {
  log(`Usage:
  bun run scripts/bench/stream-reducer.ts [--frontend-dir apps/frontend] [--runs N]
    [--kind a,b] [--chunks 500,2000,8000] [--history N] [--sharing app|off] [--json]

  --frontend-dir  A checkout's apps/frontend (default: this checkout)
  --runs          Timed passes per scenario, after one warm-up (default 5)
  --kind          Comma-separated subset of: ${STREAM_KINDS.join(', ')}
  --chunks        Comma-separated chunk counts (default ${DEFAULT_CHUNK_COUNTS.join(',')})
  --history       Settled rows above the live turn on each of two pages (default 50)
  --sharing       The transcript query's structuralSharing: the app's default or off (default app)
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
    valueFlags: ['--frontend-dir', '--runs', '--kind', '--chunks', '--history', '--sharing'],
    booleanFlags: ['--json'],
  });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);
  const [runs = 5] = parsePositiveIntegers('--runs', values['--runs'] ?? '5');
  const [history = 50] = parsePositiveIntegers('--history', values['--history'] ?? '50');
  const counts = values['--chunks']
    ? parsePositiveIntegers('--chunks', values['--chunks'])
    : [...DEFAULT_CHUNK_COUNTS];
  const kinds = (values['--kind']?.split(',') ?? [...STREAM_KINDS]).map((kind) => {
    if (!(STREAM_KINDS as readonly string[]).includes(kind)) {
      fatal(`expected \`--kind\` from ${STREAM_KINDS.join(', ')} | received: ${kind}`);
    }
    return kind as StreamKind;
  });
  const sharing = values['--sharing'] ?? 'app';
  if (sharing !== 'app' && sharing !== 'off') {
    fatal(`expected \`--sharing\` app or off | received: ${sharing}`);
  }
  const modules = await loadModules(resolve(values['--frontend-dir'] ?? 'apps/frontend'));
  if (!flags['--json']) {
    log(
      `cache patch: ${modules.patchSource} | sharing: ${sharing} | history: ${history} rows x 2 pages | runs: ${runs}`
    );
    log('kind           chunks  total ms  reducer ms  first us  last us  last/first  heap MiB');
  }
  for (const kind of kinds) {
    for (const count of counts) {
      runStream(modules, kind, count, history, sharing);
      const passes = Array.from({ length: runs }, () =>
        runStream(modules, kind, count, history, sharing)
      );
      const pick = (select: (run: StreamRun) => number) => median(passes.map(select));
      const summary = {
        kind,
        chunks: count,
        patchSource: modules.patchSource,
        sharing,
        totalMs: round(pick((run) => run.totalMs)),
        reducerOnlyMs: round(pick((run) => run.reducerOnlyMs)),
        firstUsPerChunk: round(pick((run) => run.firstUsPerChunk)),
        lastUsPerChunk: round(pick((run) => run.lastUsPerChunk)),
        lastOverFirst: round(pick((run) => run.lastUsPerChunk / run.firstUsPerChunk)),
        retainedHeapMiB: round(pick((run) => run.retainedHeapMiB)),
        identityChangesPerChunk: passes[0]?.identity,
      };
      if (flags['--json']) {
        console.log(JSON.stringify(summary));
      } else {
        log(
          `${kind.padEnd(14)} ${String(count).padStart(6)}  ${String(summary.totalMs).padStart(8)}  ${String(summary.reducerOnlyMs).padStart(10)}  ${String(summary.firstUsPerChunk).padStart(8)}  ${String(summary.lastUsPerChunk).padStart(7)}  ${String(summary.lastOverFirst).padStart(10)}  ${String(summary.retainedHeapMiB).padStart(8)}`
        );
        log(`  identity per chunk: ${JSON.stringify(summary.identityChangesPerChunk)}`);
      }
    }
  }
}
