/**
 * Differential test for delta checkpoints. Seeded random turns drive the real
 * `TurnCheckpointWriter` on SQLite (deltas) next to a reference row that is
 * rewritten whole from the live turn after every checkpoint, as the writer did
 * before deltas. After each checkpoint the folded transcript row and both
 * history readers must equal the reference; after a hard kill, crash
 * reconciliation must produce the same message from either.
 *
 * Failures print the seed and the step, so a case replays with that seed alone.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { appendMergedMessagePart } from '@mangostudio/shared/generation';
import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import {
  upsertToolCallPart,
  upsertToolResultPart,
} from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import {
  type CheckpointWriteOptions,
  createDatabaseCheckpointStore,
  createTurnCheckpointPart,
  type TurnCheckpointStore,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import { toCheckpointPart } from '../../../../src/modules/generation/application/turn-checkpoint-delta';
import { reconcileStaleTurns } from '../../../../src/modules/generation/application/turn-recovery';
import {
  insertMessage,
  listByChatId,
  loadHistory,
  loadRichHistory,
} from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const SEEDS = 150;
const STEPS_PER_SEED = 40;

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delegates to the database store, failing the next write on request. */
class FlakyDatabaseStore implements TurnCheckpointStore {
  private failNext = false;

  constructor(private readonly inner: TurnCheckpointStore) {}

  failOnce(): void {
    this.failNext = true;
  }

  clearFailure(): void {
    this.failNext = false;
  }

  rewriteRow(
    row: Parameters<TurnCheckpointStore['rewriteRow']>[0],
    options: CheckpointWriteOptions
  ): Promise<void> {
    return this.guarded(() => this.inner.rewriteRow(row, options));
  }

  appendDelta(seq: number, deltaJson: string, options: CheckpointWriteOptions): Promise<void> {
    return this.guarded(() => this.inner.appendDelta(seq, deltaJson, options));
  }

  private guarded(write: () => Promise<void>): Promise<void> {
    if (!this.failNext) return write();
    this.failNext = false;
    return Promise.reject(new Error('injected checkpoint write failure'));
  }
}

interface LiveTurn {
  text: string;
  providerState: string | null;
  readonly parts: MessagePart[];
}

type Step = (turn: LiveTurn, random: () => number, tag: string) => void;

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const words = (random: () => number, count: number): string =>
  Array.from({ length: count }, () =>
    pick(random, ['alpha', 'bravo', 'charlie', 'delta', 'echo'])
  ).join(' ');

const toolCalls = (turn: LiveTurn) =>
  turn.parts.filter(
    (p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call'
  );

/** The ways a streaming turn changes, each as the stream stages do it. */
const STEPS: readonly Step[] = [
  // Streamed text: the message text and the trailing text part grow together.
  (turn, random) => {
    const chunk = `${words(random, 1 + Math.floor(random() * 6))} `;
    turn.text += chunk;
    appendMergedMessagePart(turn.parts, { type: 'text', text: chunk });
  },
  // The model restarts its answer: the text is replaced, at any length.
  (turn, random) => {
    const last = turn.parts.at(-1);
    if (last?.type !== 'text') return;
    const restarted = words(random, 1 + Math.floor(random() * 8));
    turn.text = turn.text.slice(0, turn.text.length - last.text.length) + restarted;
    turn.parts[turn.parts.length - 1] = { type: 'text', text: restarted };
  },
  (turn, random) => {
    appendMergedMessagePart(turn.parts, { type: 'thinking', text: `${words(random, 3)} ` });
  },
  // A tool call starts, then its lifecycle moves in place.
  (turn, random, tag) => {
    upsertToolCallPart(turn.parts, {
      type: 'tool_call',
      toolCallId: `${tag}-call-${Math.floor(random() * 4)}`,
      name: pick(random, ['read_file', 'grep', 'run_shell']),
      args: random() < 0.5 ? { path: words(random, 2) } : {},
    });
  },
  (turn, random) => {
    const calls = toolCalls(turn);
    if (calls.length === 0) return;
    const call = pick(random, calls);
    call.execution = {
      status: pick(random, ['queued', 'running', 'succeeded', 'failed'] as const),
      source: 'builtin',
      queuedAt: 1,
      durationMs: Math.floor(random() * 100),
    };
  },
  // A result arrives, or the same call is upserted again with new or equal content.
  (turn, random) => {
    const calls = toolCalls(turn);
    if (calls.length === 0) return;
    const call = pick(random, calls);
    const existing = turn.parts.find(
      (p) => p.type === 'tool_result' && p.toolCallId === call.toolCallId
    );
    const content =
      existing?.type === 'tool_result' && random() < 0.5
        ? `${existing.content}`
        : `${words(random, 2)}-${'r'.repeat(Math.floor(random() * 3_000))}`;
    upsertToolResultPart(turn.parts, {
      type: 'tool_result',
      toolCallId: call.toolCallId,
      content,
      ...(random() < 0.3 ? { isError: true } : {}),
    });
  },
  // Parts pushed whole, then changed in place.
  (turn, random, tag) => {
    turn.parts.push({
      type: 'generated_image',
      imageId: `${tag}-img-${turn.parts.length}`,
      toolCallId: `${tag}-img-call`,
      status: 'generating',
      prompt: words(random, 3),
    });
  },
  (turn, random) => {
    const images = turn.parts.filter((p) => p.type === 'generated_image');
    const image = images.length > 0 ? pick(random, images) : undefined;
    if (image?.type !== 'generated_image') return;
    image.status = pick(random, ['completed', 'error'] as const);
    if (image.status === 'completed') image.imageUrl = `/images/${image.imageId}.png`;
  },
  (turn, random, tag) => {
    turn.parts.push({
      type: 'mcp_elicitation',
      elicitationId: `${tag}-elicit-${turn.parts.length}`,
      toolCallId: `${tag}-elicit-call`,
      serverSlug: 'srv',
      message: words(random, 3),
      fields: [],
      status: 'pending',
    });
  },
  (turn, random) => {
    const open = turn.parts.filter((p) => p.type === 'mcp_elicitation');
    const elicitation = open.length > 0 ? pick(random, open) : undefined;
    if (elicitation?.type !== 'mcp_elicitation') return;
    elicitation.status = pick(random, ['accepted', 'declined', 'cancelled'] as const);
  },
  // A subagent trace is pushed, then grows in place.
  (turn, random, tag) => {
    turn.parts.push({
      type: 'subagent_trace',
      toolCallId: `${tag}-sub-call`,
      agentId: 'agent',
      agentName: 'Agent',
      status: 'running',
      summary: '',
      toolCallCount: 0,
      messages: [],
      tools: [],
    });
  },
  (turn, random) => {
    const traces = turn.parts.filter((p) => p.type === 'subagent_trace');
    const trace = traces.length > 0 ? pick(random, traces) : undefined;
    if (trace?.type !== 'subagent_trace') return;
    trace.toolCallCount += 1;
    trace.summary = words(random, 4);
  },
  (turn, random) => {
    turn.providerState = random() < 0.2 ? null : `state-${Math.floor(random() * 1_000)}`;
  },
];

const stripSummary = (parts: readonly MessagePart[]): MessagePart[] =>
  parts.map((part) => toCheckpointPart(part));

interface ReplyView {
  readonly text: string;
  readonly parts: MessagePart[];
  readonly providerState: string | null;
}

async function readReplies(chatId: string) {
  const { messages } = await listByChatId(chatId, {}, getDb());
  const reply = messages.find((message) => message.role === 'ai');
  if (!reply) throw new Error(`expected an ai message in chat ${chatId} | received none`);
  const history = await loadHistory(chatId, {}, getDb());
  const rich = await loadRichHistory(chatId, {}, getDb());
  const view = (r: {
    text: string;
    parts?: MessagePart[];
    providerState?: string | null;
  }): ReplyView => ({
    text: r.text,
    parts: stripSummary(r.parts ?? []),
    providerState: r.providerState ?? null,
  });
  return {
    transcript: view(reply),
    history: history.map((turn) => ({ role: turn.role, text: turn.text })),
    rich: rich.map((turn) => ({ role: turn.role, ...view(turn) })),
  };
}

async function seedTurn(chatId: string, replyId: string, checkpoint: MessagePart): Promise<void> {
  const base = Date.now();
  await insertMessage(
    {
      id: crypto.randomUUID(),
      chatId,
      role: 'user',
      text: 'go',
      timestamp: base,
      isGenerating: false,
      interactionMode: 'agent',
    },
    getDb()
  );
  await insertMessage(
    {
      id: replyId,
      chatId,
      role: 'ai',
      text: '',
      timestamp: base + 1,
      isGenerating: true,
      interactionMode: 'agent',
      parts: JSON.stringify([checkpoint]),
    },
    getDb()
  );
}

/** The reference: the whole live turn written to the row after every checkpoint. */
async function rewriteReference(replyId: string, turn: LiveTurn): Promise<void> {
  await getDb()
    .updateTable('messages')
    .set({
      text: turn.text,
      parts: JSON.stringify(turn.parts),
      providerState: turn.providerState,
    })
    .where('id', '=', replyId)
    .execute();
}

async function runSeed(seed: number): Promise<void> {
  const random = seededRandom(seed);
  const user = await insertTestUser();
  const deltaChat = await insertTestChat(user.id);
  const referenceChat = await insertTestChat(user.id);
  const deltaReplyId = crypto.randomUUID();
  const referenceReplyId = crypto.randomUUID();
  const checkpoint = createTurnCheckpointPart({
    turnId: deltaReplyId,
    startedAt: 1_000,
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
  const turn: LiveTurn = { text: '', providerState: null, parts: [checkpoint] };
  await seedTurn(deltaChat.id, deltaReplyId, checkpoint);
  await seedTurn(referenceChat.id, referenceReplyId, checkpoint);

  const store = new FlakyDatabaseStore(createDatabaseCheckpointStore(getDb(), deltaReplyId));
  const writer = new TurnCheckpointWriter({
    store,
    chatId: deltaChat.id,
    messageId: deltaReplyId,
    checkpoint,
    getContent: () => ({ text: turn.text, parts: turn.parts, providerState: turn.providerState }),
    defer: (run) => run(),
  });
  const tag = `s${seed}`;

  const compare = async (step: number): Promise<void> => {
    await rewriteReference(referenceReplyId, turn);
    const [actual, expected] = await Promise.all([
      readReplies(deltaChat.id),
      readReplies(referenceChat.id),
    ]);
    const where = `seed ${seed} step ${step}`;
    expect({ where, ...actual }).toEqual({ where, ...expected });
  };

  for (let step = 0; step < STEPS_PER_SEED; step++) {
    pick(random, STEPS)(turn, random, tag);
    const roll = random();
    if (roll < 0.08) store.failOnce();
    if (roll < 0.25) {
      // Best effort, then drained: the trailing write may be the one that fails.
      await writer.checkpoint();
      await writer.flush();
    } else if (roll < 0.5) {
      if (await writer.checkpoint({ force: true })) await compare(step);
    }
  }

  // The last checkpoint lands whole, then the process dies with more unwritten.
  store.clearFailure();
  expect(await writer.checkpoint({ force: true })).toBe(true);
  await compare(STEPS_PER_SEED);
  pick(random, STEPS)(turn, random, tag);

  // Recovery stamps the clock into the parts it seals; pin it so the two runs are comparable.
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try {
    await reconcileStaleTurns({ chatId: deltaChat.id, reasonCode: 'server_restart' }, getDb());
    await reconcileStaleTurns({ chatId: referenceChat.id, reasonCode: 'server_restart' }, getDb());
  } finally {
    clock.mockRestore();
  }
  const [recovered, expected] = await Promise.all([
    readReplies(deltaChat.id),
    readReplies(referenceChat.id),
  ]);
  const where = `seed ${seed} after hard kill`;
  expect({ where, ...recovered }).toEqual({ where, ...expected });
}

describe('delta checkpoints against a full-rewrite reference', () => {
  it(`match after every checkpoint and after a hard kill, over ${SEEDS} seeded turns`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runSeed(seed);
  }, 120_000);
});
