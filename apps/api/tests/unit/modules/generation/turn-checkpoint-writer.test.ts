import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { isTurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import {
  CHECKPOINT_TEXT_INTERVAL_CHARS,
  type CheckpointWriteOptions,
  createDatabaseCheckpointStore,
  createTurnCheckpointPart,
  type TurnCheckpointStore,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import {
  type CheckpointDelta,
  type CheckpointedContent,
  foldCheckpointDeltas,
  foldCheckpointDeltasIntoRows,
} from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

interface RecordedWrite {
  readonly text: string;
  readonly sequence: number;
  readonly partCount: number;
  readonly checkpointedAt: number;
  readonly status: string;
  readonly reasonCode: string | undefined;
  /** How the write reached the store: a full row or a delta. */
  readonly kind: 'rewrite' | 'delta';
  /** Characters handed to the store. */
  readonly bytes: number;
  /** Whether the writer asked the store for a commit at synchronous = FULL. */
  readonly durable: boolean;
}

interface PendingWrite {
  readonly write: RecordedWrite;
  release(): void;
  fail(error: Error): void;
}

/**
 * Named fake for the checkpoint store. A write that starts is recorded with the
 * message it leaves behind (a delta folded over the stored state, as a reader
 * would see it); while `hold()` is on it stays in flight until released or
 * failed. A failed write leaves the stored state as it was.
 */
class HeldCheckpointStore implements TurnCheckpointStore {
  readonly writes: RecordedWrite[] = [];
  readonly inFlight: PendingWrite[] = [];
  private holding = false;
  private failNext: Error | null = null;
  private stored: CheckpointedContent = {
    text: '',
    parts: [],
    providerState: null,
    generationTime: null,
  };

  hold(): void {
    this.holding = true;
  }

  failNextWrite(error: Error): void {
    this.failNext = error;
  }

  releaseOldest(): void {
    this.inFlight.shift()?.release();
  }

  releaseAll(): void {
    this.holding = false;
    while (this.inFlight.length > 0) this.releaseOldest();
  }

  rewriteRow(
    row: {
      text: string;
      partsJson: string;
      providerState: string | null;
      generationTime: string | null | undefined;
    },
    options: CheckpointWriteOptions
  ): Promise<void> {
    return this.start(
      'rewrite',
      {
        text: row.text,
        parts: JSON.parse(row.partsJson) as MessagePart[],
        providerState: row.providerState,
        generationTime: row.generationTime ?? null,
      },
      row.text.length + row.partsJson.length,
      options.durable
    );
  }

  appendDelta(_seq: number, deltaJson: string, options: CheckpointWriteOptions): Promise<void> {
    return this.start(
      'delta',
      foldCheckpointDeltas(this.stored, [JSON.parse(deltaJson) as CheckpointDelta]),
      deltaJson.length,
      options.durable
    );
  }

  private start(
    kind: RecordedWrite['kind'],
    next: CheckpointedContent,
    bytes: number,
    durable: boolean
  ): Promise<void> {
    const checkpoint = next.parts.find(isTurnCheckpointPart);
    if (!checkpoint) throw new Error('expected a turn_checkpoint part in the stored parts');
    const write = {
      kind,
      bytes,
      durable,
      text: next.text,
      sequence: checkpoint.sequence,
      partCount: next.parts.length,
      checkpointedAt: checkpoint.checkpointedAt,
      status: checkpoint.status,
      reasonCode: checkpoint.reasonCode,
    };
    this.writes.push(write);
    const failure = this.failNext;
    this.failNext = null;
    if (failure) return Promise.reject(failure);
    if (!this.holding) {
      this.stored = next;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.inFlight.push({
        write,
        release: () => {
          this.stored = next;
          resolve();
        },
        fail: reject,
      });
    });
  }
}

/** Collects best-effort wake-ups so a test decides when the macrotask "fires". */
class ManualDefer {
  private readonly queue: Array<() => void> = [];

  readonly defer = (run: () => void): void => {
    this.queue.push(run);
  };

  fire(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const store = new HeldCheckpointStore();
  const manual = new ManualDefer();
  const checkpoint = createTurnCheckpointPart({
    turnId: 'turn-1',
    startedAt: 1_000,
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
  const parts: MessagePart[] = [checkpoint];
  const state = { text: '', now: 1_000 };
  const writer = new TurnCheckpointWriter({
    store,
    chatId: 'chat-1',
    messageId: 'turn-1',
    checkpoint,
    getContent: () => ({ text: state.text, parts, providerState: null }),
    now: () => state.now,
    defer: manual.defer,
  });
  const append = (chars: number) => {
    state.text += 'x'.repeat(chars);
    parts.push({ type: 'text', text: 'x'.repeat(chars) });
  };
  return { store, manual, checkpoint, parts, state, writer, append };
}

describe('TurnCheckpointWriter', () => {
  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  it('writes one snapshot with the latest state for many accepted best-effort calls', async () => {
    const { store, manual, writer, append } = setup();
    store.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    expect(await writer.checkpoint()).toBe(true);
    manual.fire();
    await tick();
    expect(store.writes).toHaveLength(1);

    for (let call = 0; call < 256; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      expect(await writer.checkpoint()).toBe(true);
    }
    manual.fire();
    await tick();
    // The held write blocks the trailing one, which has not started or been planned.
    expect(store.writes).toHaveLength(1);

    const flushed = writer.flush();
    store.releaseAll();
    await flushed;

    expect(store.writes).toHaveLength(2);
    const latest = store.writes[1];
    expect(latest?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 257);
    expect(latest?.partCount).toBe(258);
  });

  it('counts every accepted best-effort call in the persisted sequence', async () => {
    const { store, manual, writer, append } = setup();
    store.hold();
    for (let call = 0; call < 5; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
      manual.fire();
    }
    const flushed = writer.flush();
    store.releaseAll();
    await flushed;

    const sequences = store.writes.map((write) => write.sequence);
    expect(sequences[sequences.length - 1]).toBe(5);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('writes a forced checkpoint queued behind best-effort ones, in order and complete', async () => {
    const { store, manual, writer, append } = setup();
    store.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await tick();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    append(10);
    const forced = writer.checkpoint({ force: true });
    append(10);
    const secondForced = writer.checkpoint({ force: true });
    store.releaseAll();

    expect(await forced).toBe(true);
    expect(await secondForced).toBe(true);
    await writer.flush();

    const texts = store.writes.map((write) => write.text.length);
    expect(texts[0]).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS);
    // Both forced calls land as their own writes carrying the state at call time.
    expect(texts.slice(-2)).toEqual([
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2 + 10,
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2 + 20,
    ]);
    expect(store.writes.map((write) => write.sequence)).toEqual(
      [...store.writes.map((write) => write.sequence)].sort((a, b) => a - b)
    );
  });

  it('never lets a stale forced snapshot land after newer best-effort state', async () => {
    const { store, manual, writer, append } = setup();
    store.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await tick();
    // A best-effort write is held. Queue a trailing best-effort one, then a
    // forced one, then newer best-effort state accepted after the forced call.
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    void writer.flush();
    append(5);
    const forced = writer.checkpoint({ force: true });
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    store.releaseAll();
    await forced;
    await writer.flush();

    const lengths = store.writes.map((write) => write.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths[lengths.length - 1]).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 3 + 5);
  });

  it('lands the final state last and complete through prepareFinal', async () => {
    const { store, manual, checkpoint, writer, append } = setup();
    store.hold();
    for (let call = 0; call < 10; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
      manual.fire();
    }

    const finalState = writer.prepareFinal('completed');
    store.releaseAll();
    const content = await finalState;

    // Everything accepted before the final is on disk before prepareFinal returns.
    const last = store.writes[store.writes.length - 1];
    expect(last?.text).toBe(content.text);
    expect(last?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 10);
    // prepareFinal itself adds the completed state on top of the 10 accepted calls.
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.sequence).toBe(11);
    expect(checkpoint.lastAssistantText.length).toBeGreaterThan(0);
  });

  it('drains accepted best-effort text before an interrupted turn is finalized', async () => {
    const { store, checkpoint, writer, append } = setup();
    for (let call = 0; call < 3; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
    }
    // The wake-up never fired: the abort path goes straight to prepareFinal.
    expect(store.writes).toHaveLength(0);

    const content = await writer.prepareFinal('interrupted', 'user_cancelled');

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.text).toBe(content.text);
    expect(content.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 3);
    expect(checkpoint.status).toBe('interrupted');
    expect(checkpoint.reasonCode).toBe('user_cancelled');
    expect(checkpoint.sequence).toBe(4);
  });

  it('reports a failed write as false and keeps later writes landing', async () => {
    const { store, writer, append } = setup();
    store.failNextWrite(new Error('disk full'));
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(false);

    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    expect(store.writes.map((write) => write.text.length)).toEqual([10, 20]);
  });

  it('keeps a failed best-effort write from blocking the next one', async () => {
    const { store, manual, writer, append } = setup();
    store.failNextWrite(new Error('disk full'));
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await writer.flush();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await writer.flush();

    expect(store.writes.map((write) => write.text.length)).toEqual([
      CHECKPOINT_TEXT_INTERVAL_CHARS,
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2,
    ]);
  });

  it('flush starts the trailing write without waiting for the deferred wake-up', async () => {
    const { store, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    expect(store.writes).toHaveLength(0);

    await writer.flush();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS);
  });

  it('keeps a flush barrier open until the forced write that superseded its snapshot lands', async () => {
    const { store, manual, writer, append } = setup();
    store.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await tick();
    // The first write is held. Accept newer state, flush it behind the held
    // write, then let a forced checkpoint supersede that queued snapshot.
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    let flushed = false;
    const flush = writer.flush().then(() => {
      flushed = true;
    });
    append(5);
    const forced = writer.checkpoint({ force: true });

    store.releaseOldest();
    await tick();

    // The forced write has started and is held: flush must still be waiting for it.
    expect({
      flushed,
      writesStarted: store.writes.length,
      inFlight: store.inFlight.length,
    }).toEqual({
      flushed: false,
      writesStarted: 2,
      inFlight: 1,
    });

    store.releaseAll();
    await flush;
    expect(await forced).toBe(true);
    expect(store.writes[store.writes.length - 1]?.text.length).toBe(
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2 + 5
    );
  });

  it('writes a status or reason code passed without force at call time', async () => {
    const { store, checkpoint, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);

    expect(await writer.checkpoint({ status: 'interrupted', reasonCode: 'user_cancelled' })).toBe(
      true
    );

    expect(store.writes.map((write) => [write.status, write.reasonCode])).toEqual([
      ['interrupted', 'user_cancelled'],
    ]);
    expect(checkpoint.status).toBe('interrupted');
  });

  it('skips calls below the throttle without scheduling a write', async () => {
    const { store, manual, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS - 1);
    expect(await writer.checkpoint()).toBe(false);
    manual.fire();
    await writer.flush();
    expect(store.writes).toHaveLength(0);
  });
});

describe('TurnCheckpointWriter write shape', () => {
  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  const toolResult = (toolCallId: string, length: number): MessagePart => ({
    type: 'tool_result',
    toolCallId,
    content: 'r'.repeat(length),
  });

  it('rewrites the row once, then writes only what each checkpoint added', async () => {
    const { store, writer, append } = setup();
    for (let call = 0; call < 4; call++) {
      append(100);
      expect(await writer.checkpoint({ force: true })).toBe(true);
    }

    expect(store.writes.map((write) => write.kind)).toEqual(['rewrite', 'delta', 'delta', 'delta']);
    // 100 new characters travel with the delta, not the 400 stored so far.
    for (const delta of store.writes.slice(1)) expect(delta.bytes).toBeLessThan(900);
  });

  it('stores a tool result once however many checkpoints follow it', async () => {
    const { store, parts, writer } = setup();
    const resultLength = 50_000;
    for (let call = 0; call < 10; call++) {
      parts.push(toolResult(`call-${call}`, resultLength));
      expect(await writer.checkpoint({ force: true })).toBe(true);
    }

    const written = store.writes.reduce((sum, write) => sum + write.bytes, 0);
    // Rewriting the row at each checkpoint would carry 55 results (2.75M characters).
    expect(written).toBeGreaterThanOrEqual(10 * resultLength);
    expect(written).toBeLessThan(10 * resultLength + 20_000);
  });

  it('asks the store for a durable commit only for the checkpoint that requests one', async () => {
    const { store, writer, parts } = setup();
    expect(await writer.checkpoint({ force: true })).toBe(true);
    parts.push({ type: 'tool_call', toolCallId: 'call-1', name: 'run_shell', args: {} });
    expect(await writer.checkpoint({ durable: true })).toBe(true);
    parts.push({ type: 'tool_result', toolCallId: 'call-1', content: 'ok' });
    expect(await writer.checkpoint({ force: true })).toBe(true);

    // The first write is a full row, the others deltas; only the second is durable.
    expect(store.writes.map(({ kind, durable }) => ({ kind, durable }))).toEqual([
      { kind: 'rewrite', durable: false },
      { kind: 'delta', durable: true },
      { kind: 'delta', durable: false },
    ]);
  });

  it('writes a durable first checkpoint as a durable full row', async () => {
    const { store, writer } = setup();

    expect(await writer.checkpoint({ durable: true })).toBe(true);

    expect(store.writes.map(({ kind, durable }) => ({ kind, durable }))).toEqual([
      { kind: 'rewrite', durable: true },
    ]);
  });

  it('writes a durable checkpoint even when the throttle would skip a best-effort one', async () => {
    const { store, writer } = setup();
    expect(await writer.checkpoint({ force: true })).toBe(true);

    // Same instant, no new text: a best-effort call is skipped, a durable one is required.
    expect(await writer.checkpoint()).toBe(false);
    expect(await writer.checkpoint({ durable: true })).toBe(true);

    expect(store.writes.map(({ durable }) => durable)).toEqual([false, true]);
  });

  it('does not send a result again when a later upsert replaces it with an equal copy', async () => {
    const { store, parts, writer } = setup();
    const content = 'r'.repeat(50_000);
    parts.push({ type: 'tool_result', toolCallId: 'call-mixed', content });
    expect(await writer.checkpoint({ force: true })).toBe(true);

    // As in a mixed image batch: the progress sync wrote the result, a checkpoint
    // landed, then the collector upserted it again as a new object.
    parts[1] = { type: 'tool_result', toolCallId: 'call-mixed', content: `${content}` };
    expect(await writer.checkpoint({ force: true })).toBe(true);

    const [first, second] = store.writes;
    expect(first?.bytes).toBeGreaterThanOrEqual(50_000);
    expect(second?.kind).toBe('delta');
    expect(second?.bytes).toBeLessThan(1_000);
  });

  it('rewrites the row after a failed write rather than leaving a gap in the deltas', async () => {
    const { store, writer, append } = setup();
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    store.failNextWrite(new Error('disk full'));
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(false);

    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);

    expect(store.writes.map((write) => [write.kind, write.text.length])).toEqual([
      ['rewrite', 10],
      ['delta', 20],
      ['rewrite', 30],
    ]);
  });

  it('drops a delta that was planned on top of a write which then failed', async () => {
    const { store, writer, append } = setup();
    store.hold();
    append(10);
    const first = writer.checkpoint({ force: true });
    append(10);
    const second = writer.checkpoint({ force: true });
    append(10);
    const third = writer.checkpoint({ force: true });
    await tick();
    // Only the first write (a full row) has started; the other two are deltas
    // planned against it and waiting in the queue.
    expect(store.inFlight).toHaveLength(1);
    store.inFlight[0]?.fail(new Error('disk full'));

    expect(await Promise.all([first, second, third])).toEqual([false, false, false]);
    expect(store.writes).toHaveLength(1);

    store.releaseAll();
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    // The next write is a complete row, not a delta over the one that never landed.
    expect(store.writes.map((write) => [write.kind, write.text.length])).toEqual([
      ['rewrite', 10],
      ['rewrite', 40],
    ]);
  });

  it('rewrites, rather than drops, a durable delta planned on top of a write which then failed', async () => {
    const { store, writer, append } = setup();
    store.hold();
    append(10);
    const first = writer.checkpoint({ force: true });
    append(10);
    const marker = writer.checkpoint({ durable: true });
    append(10);
    const after = writer.checkpoint({ force: true });
    await tick();
    expect(store.inFlight).toHaveLength(1);
    store.inFlight[0]?.fail(new Error('disk full'));
    await tick();
    store.releaseAll();

    const outcomes = await Promise.all([first, marker, after]);
    append(10);
    const next = await writer.checkpoint({ force: true });

    // The durable marker lands as a durable full row of the turn as it is when the
    // write runs; the ordinary delta behind it is dropped; the checkpoint after that
    // is a delta over the re-planned row.
    expect({
      outcomes,
      next,
      writes: store.writes.map((write) => [write.kind, write.durable, write.text.length]),
    }).toEqual({
      outcomes: [false, true, false],
      next: true,
      writes: [
        ['rewrite', false, 10],
        ['rewrite', true, 30],
        ['delta', false, 40],
      ],
    });
  });

  it('drops a delta planned while a re-planned rewrite was in flight when a second one supersedes it', async () => {
    const { store, writer, append, state } = setup();
    store.hold();
    append(10);
    const first = writer.checkpoint({ force: true });
    append(10);
    const firstMarker = writer.checkpoint({ durable: true });
    append(10);
    const secondMarker = writer.checkpoint({ durable: true });
    await tick();
    // The first write fails: the first marker, planned as a delta on top of it, is
    // planned again as a rewrite and goes in flight.
    store.inFlight[0]?.fail(new Error('disk full'));
    await tick();
    // The failed write stays listed; the second entry is the re-planned rewrite.
    expect(store.inFlight).toHaveLength(2);
    // Planned against the re-planned rewrite, while it is in flight.
    append(10);
    const late = writer.checkpoint({ force: true });
    store.releaseAll();

    const outcomes = await Promise.all([first, firstMarker, secondMarker, late]);

    // The second marker was planned before the first was planned again, so it is planned
    // again too, as a rewrite of the live turn (40 characters). The late delta was
    // planned against the state that rewrite replaced and its text is already in it:
    // folded over it, the row would hold 50 characters of a 40 character turn.
    expect({
      outcomes,
      writes: store.writes.map((write) => [write.kind, write.durable, write.text.length]),
      stored: store.writes.at(-1)?.text.length,
      live: state.text.length,
    }).toEqual({
      outcomes: [false, true, true, false],
      writes: [
        ['rewrite', false, 10],
        ['rewrite', true, 30],
        ['rewrite', true, 40],
      ],
      stored: 40,
      live: 40,
    });
  });

  it('reports a durable write that itself failed as false, and rewrites on the next checkpoint', async () => {
    const { store, writer, append } = setup();
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    store.failNextWrite(new Error('disk full'));
    append(10);

    const marker = await writer.checkpoint({ durable: true });
    append(10);
    const next = await writer.checkpoint({ durable: true });

    expect({
      marker,
      next,
      writes: store.writes.map((write) => [write.kind, write.durable, write.text.length]),
    }).toEqual({
      marker: false,
      next: true,
      writes: [
        ['rewrite', false, 10],
        ['delta', true, 20],
        ['rewrite', true, 30],
      ],
    });
  });

  it('writes a trailing text part that grows in place as an append', async () => {
    const { store, parts, writer, state } = setup();
    parts.push({ type: 'text', text: 'a'.repeat(5_000) });
    state.text = 'a'.repeat(5_000);
    await writer.checkpoint({ force: true });
    (parts[1] as { text: string }).text += 'bc';
    state.text += 'bc';
    await writer.checkpoint({ force: true });

    expect(store.writes.map((write) => [write.kind, write.text.length, write.partCount])).toEqual([
      ['rewrite', 5_000, 2],
      ['delta', 5_002, 2],
    ]);
    expect(store.writes[1]?.bytes).toBeLessThan(800);
  });
});

interface DurableRow {
  readonly text: string;
  readonly isGenerating: number;
  readonly parts: MessagePart[];
}

/** The real in-memory `messages` row for one generating assistant turn. */
async function setupDurable(options: { defer?: (run: () => void) => void } = {}) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const turnId = crypto.randomUUID();
  const checkpoint = createTurnCheckpointPart({
    turnId,
    startedAt: 1_000,
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
  const parts: MessagePart[] = [checkpoint];
  const state = { text: '', now: 1_000 };
  await insertMessage(
    {
      id: turnId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: true,
      interactionMode: 'chat',
      parts: JSON.stringify(parts),
    },
    getDb()
  );
  const writer = new TurnCheckpointWriter({
    store: createDatabaseCheckpointStore(getDb(), turnId),
    chatId: chat.id,
    messageId: turnId,
    checkpoint,
    getContent: () => ({ text: state.text, parts, providerState: null }),
    now: () => state.now,
    ...(options.defer ? { defer: options.defer } : {}),
  });
  const append = (chars: number) => {
    state.text += 'x'.repeat(chars);
    parts.push({ type: 'text', text: 'x'.repeat(chars) });
  };
  /** The row as a reader sees it: the stored columns with the checkpoint deltas folded in. */
  const readRow = async (): Promise<DurableRow> => {
    const stored = await getDb()
      .selectFrom('messages')
      .select(['id', 'text', 'parts', 'providerState', 'generationTime', 'isGenerating'])
      .where('id', '=', turnId)
      .executeTakeFirstOrThrow();
    const [row] = await foldCheckpointDeltasIntoRows([stored], getDb());
    return {
      text: row?.text ?? '',
      isGenerating: row?.isGenerating ?? -1,
      parts: JSON.parse(row?.parts ?? '[]') as MessagePart[],
    };
  };
  const finalize = () =>
    getDb().updateTable('messages').set({ isGenerating: 0 }).where('id', '=', turnId).execute();
  return { checkpoint, writer, append, readRow, finalize, turnId };
}

describe('TurnCheckpointWriter on SQLite', () => {
  it('lands the trailing write after a tick with the default wake-up', async () => {
    const { writer, append, readRow } = await setupDurable();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    expect(await writer.checkpoint()).toBe(true);
    // Accepted, not yet written: the default wake-up is a later macrotask.
    expect((await readRow()).text).toBe('');

    await tick();
    await writer.flush();

    const row = await readRow();
    expect(row.text).toHaveLength(CHECKPOINT_TEXT_INTERVAL_CHARS);
    expect(row.parts.find(isTurnCheckpointPart)?.sequence).toBe(1);
  });

  it('makes the trailing write a no-op once the turn is no longer generating', async () => {
    const { writer, append, readRow, finalize } = await setupDurable();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    // The turn is finalized before the wake-up fires; the `isGenerating = 1`
    // guard must keep the late snapshot from overwriting the final row.
    await finalize();

    await tick();
    await writer.flush();

    const row = await readRow();
    expect(row.isGenerating).toBe(0);
    expect(row.text).toBe('');
    expect(row.parts.find(isTurnCheckpointPart)?.sequence).toBe(0);
  });

  it('leaves no delta rows behind when a late checkpoint loses the race with finalize', async () => {
    const { writer, append, finalize, turnId } = await setupDurable();
    append(10);
    await writer.checkpoint({ force: true });
    append(10);
    await writer.checkpoint({ force: true });
    await finalize();

    append(10);
    await writer.checkpoint({ force: true });

    // Scoped to this message: other tests in the process leave deltas of their own.
    const left = await getDb()
      .selectFrom('message_checkpoint_deltas')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('messageId', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(left.count).toBe(0);
  });

  it('leaves the last forced state as the durable row when the turn crashes', async () => {
    const manual = new ManualDefer();
    const { writer, append, readRow } = await setupDurable({ defer: manual.defer });
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    const forced = await readRow();

    // Accepted after the last landed write, then the process dies: neither the
    // wake-up nor flush ever runs.
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    await tick();

    const durable = await readRow();
    expect(durable).toEqual(forced);
    expect(durable.text).toHaveLength(CHECKPOINT_TEXT_INTERVAL_CHARS + 10);
    expect(durable.parts).toHaveLength(3);
    expect(durable.parts.find(isTurnCheckpointPart)?.sequence).toBe(2);
  });
});
