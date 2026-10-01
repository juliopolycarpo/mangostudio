import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { isTurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { Kysely } from 'kysely';
import type { Database } from '../../../../src/db/types';
import {
  CHECKPOINT_TEXT_INTERVAL_CHARS,
  createTurnCheckpointPart,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';

interface RecordedWrite {
  readonly text: string;
  readonly sequence: number;
  readonly partCount: number;
  readonly checkpointedAt: number;
}

interface PendingWrite {
  readonly write: RecordedWrite;
  release(): void;
  fail(error: Error): void;
}

/**
 * Named fake for the `messages` checkpoint update. A write that starts is
 * recorded with the serialized state it carries; while `hold()` is on it stays
 * in flight until released or failed.
 */
class HeldCheckpointDb {
  readonly writes: RecordedWrite[] = [];
  readonly inFlight: PendingWrite[] = [];
  private holding = false;
  private failNext: Error | null = null;

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

  asKysely(): Kysely<Database> {
    return this as unknown as Kysely<Database>;
  }

  updateTable(table: string) {
    if (table !== 'messages') throw new Error(`expected table: messages | received: ${table}`);
    return new HeldUpdate(this);
  }

  start(values: { text: string; parts: string }): Promise<void> {
    const checkpoint = (JSON.parse(values.parts) as MessagePart[]).find(isTurnCheckpointPart);
    if (!checkpoint) throw new Error('expected a turn_checkpoint part in the serialized parts');
    const write = {
      text: values.text,
      sequence: checkpoint.sequence,
      partCount: (JSON.parse(values.parts) as MessagePart[]).length,
      checkpointedAt: checkpoint.checkpointedAt,
    };
    this.writes.push(write);
    const failure = this.failNext;
    this.failNext = null;
    if (failure) return Promise.reject(failure);
    if (!this.holding) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.inFlight.push({ write, release: resolve, fail: reject });
    });
  }
}

class HeldUpdate {
  private values: { text: string; parts: string } = { text: '', parts: '[]' };

  constructor(private readonly db: HeldCheckpointDb) {}

  set(values: { text: string; parts: string }): this {
    this.values = values;
    return this;
  }

  where(): this {
    return this;
  }

  execute(): Promise<void> {
    return this.db.start(this.values);
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
  const db = new HeldCheckpointDb();
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
    db: db.asKysely(),
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
  return { db, manual, checkpoint, parts, state, writer, append };
}

describe('TurnCheckpointWriter', () => {
  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  it('writes one snapshot with the latest state for many accepted best-effort calls', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    expect(await writer.checkpoint()).toBe(true);
    manual.fire();
    await tick();
    expect(db.writes).toHaveLength(1);

    for (let call = 0; call < 256; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      expect(await writer.checkpoint()).toBe(true);
    }
    manual.fire();
    await tick();
    // The held write blocks the trailing one, which has not started or serialized.
    expect(db.writes).toHaveLength(1);

    const flushed = writer.flush();
    db.releaseAll();
    await flushed;

    expect(db.writes).toHaveLength(2);
    const latest = db.writes[1];
    expect(latest?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 257);
    expect(latest?.partCount).toBe(258);
  });

  it('counts every accepted best-effort call in the persisted sequence', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();
    for (let call = 0; call < 5; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
      manual.fire();
    }
    const flushed = writer.flush();
    db.releaseAll();
    await flushed;

    const sequences = db.writes.map((write) => write.sequence);
    expect(sequences[sequences.length - 1]).toBe(5);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('writes a forced checkpoint queued behind best-effort ones, in order and complete', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

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
    db.releaseAll();

    expect(await forced).toBe(true);
    expect(await secondForced).toBe(true);
    await writer.flush();

    const texts = db.writes.map((write) => write.text.length);
    expect(texts[0]).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS);
    // Both forced calls land as their own writes carrying the state at call time.
    expect(texts.slice(-2)).toEqual([
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2 + 10,
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2 + 20,
    ]);
    expect(db.writes.map((write) => write.sequence)).toEqual(
      [...db.writes.map((write) => write.sequence)].sort((a, b) => a - b)
    );
  });

  it('never lets a stale forced snapshot land after newer best-effort state', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await tick();
    // A best-effort write is held. Queue a trailing best-effort one, then a
    // forced one, then newer best-effort state accepted after the forced call.
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    writer.flush();
    append(5);
    const forced = writer.checkpoint({ force: true });
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    db.releaseAll();
    await forced;
    await writer.flush();

    const lengths = db.writes.map((write) => write.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths[lengths.length - 1]).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 3 + 5);
  });

  it('lands the final state last and complete through prepareFinal', async () => {
    const { db, manual, checkpoint, writer, append } = setup();
    db.hold();
    for (let call = 0; call < 10; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
      manual.fire();
    }

    const finalState = writer.prepareFinal('completed');
    db.releaseAll();
    const content = await finalState;

    // Everything accepted before the final is on disk before prepareFinal returns.
    const last = db.writes[db.writes.length - 1];
    expect(last?.text).toBe(content.text);
    expect(last?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 10);
    // prepareFinal itself adds the completed state on top of the 10 accepted calls.
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.sequence).toBe(11);
    expect(checkpoint.lastAssistantText.length).toBeGreaterThan(0);
  });

  it('drains accepted best-effort text before an interrupted turn is finalized', async () => {
    const { db, checkpoint, writer, append } = setup();
    for (let call = 0; call < 3; call++) {
      append(CHECKPOINT_TEXT_INTERVAL_CHARS);
      await writer.checkpoint();
    }
    // The wake-up never fired: the abort path goes straight to prepareFinal.
    expect(db.writes).toHaveLength(0);

    const content = await writer.prepareFinal('interrupted', 'user_cancelled');

    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.text).toBe(content.text);
    expect(content.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS * 3);
    expect(checkpoint.status).toBe('interrupted');
    expect(checkpoint.reasonCode).toBe('user_cancelled');
    expect(checkpoint.sequence).toBe(4);
  });

  it('loses only text after the last landed checkpoint when the turn crashes', async () => {
    const { db, manual, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await writer.flush();

    // Accepted after the last landed write, then the process dies: neither the
    // wake-up nor flush ever runs.
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();

    expect(db.writes).toHaveLength(1);
    const landed = db.writes[0];
    expect(landed?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS);
    expect(landed?.partCount).toBe(2);
    expect(landed?.sequence).toBe(1);
  });

  it('reports a failed write as false and keeps later writes landing', async () => {
    const { db, writer, append } = setup();
    db.failNextWrite(new Error('disk full'));
    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(false);

    append(10);
    expect(await writer.checkpoint({ force: true })).toBe(true);
    expect(db.writes.map((write) => write.text.length)).toEqual([10, 20]);
  });

  it('keeps a failed best-effort write from blocking the next one', async () => {
    const { db, manual, writer, append } = setup();
    db.failNextWrite(new Error('disk full'));
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await writer.flush();

    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    manual.fire();
    await writer.flush();

    expect(db.writes.map((write) => write.text.length)).toEqual([
      CHECKPOINT_TEXT_INTERVAL_CHARS,
      CHECKPOINT_TEXT_INTERVAL_CHARS * 2,
    ]);
  });

  it('flush starts the trailing write without waiting for the deferred wake-up', async () => {
    const { db, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS);
    await writer.checkpoint();
    expect(db.writes).toHaveLength(0);

    await writer.flush();
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.text.length).toBe(CHECKPOINT_TEXT_INTERVAL_CHARS);
  });

  it('skips calls below the throttle without scheduling a write', async () => {
    const { db, manual, writer, append } = setup();
    append(CHECKPOINT_TEXT_INTERVAL_CHARS - 1);
    expect(await writer.checkpoint()).toBe(false);
    manual.fire();
    await writer.flush();
    expect(db.writes).toHaveLength(0);
  });
});
