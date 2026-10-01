import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import type { Kysely } from 'kysely';
import { getDb } from '../../../../src/db/database';
import type { Database } from '../../../../src/db/types';
import { ExternalTranscriptWriter } from '../../../../src/modules/external-agents/application/external-transcript-writer';
import { ExternalTurnTranscript } from '../../../../src/modules/external-agents/domain/external-turn-transcript';
import { CHECKPOINT_TEXT_INTERVAL_CHARS } from '../../../../src/modules/generation/application/turn-checkpoint';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const CHUNK = CHECKPOINT_TEXT_INTERVAL_CHARS;

interface RecordedWrite {
  readonly text: string;
  readonly partCount: number;
  readonly steerStatus: string | undefined;
}

interface PendingWrite {
  readonly write: RecordedWrite;
  release(): void;
  fail(error: Error): void;
}

/**
 * Named fake for the `messages` transcript update. A write that starts is
 * recorded with the serialized state it carries; while `hold()` is on it stays
 * in flight until released or failed.
 */
class HeldTranscriptDb {
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

  failOldest(error: Error): void {
    this.inFlight.shift()?.fail(error);
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
    const parts = JSON.parse(values.parts) as MessagePart[];
    const steer = parts.find((part) => part.type === 'external_steer');
    const write = {
      text: values.text,
      partCount: parts.length,
      steerStatus: steer?.type === 'external_steer' ? steer.status : undefined,
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

  constructor(private readonly db: HeldTranscriptDb) {}

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

  get armed(): number {
    return this.queue.length;
  }

  fire(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function newTranscript() {
  const transcript = new ExternalTurnTranscript({
    targetId: 'codex',
    sessionId: 'session-1',
    startedAt: 1_000,
  });
  let sequence = 0;
  const append = (chars: number) => {
    sequence += 1;
    transcript.apply(
      { type: 'text_delta', text: 'x'.repeat(chars) },
      { sequence, at: 1_000 + sequence }
    );
  };
  return { transcript, append };
}

function setup() {
  const db = new HeldTranscriptDb();
  const manual = new ManualDefer();
  const { transcript, append } = newTranscript();
  const state = { now: 1_000 };
  const writer = new ExternalTranscriptWriter(
    db.asKysely(),
    'message-1',
    transcript,
    () => state.now,
    manual.defer
  );
  const steer = (id = 'steer-1') => {
    transcript.recordSteerAttempt({ clientMessageId: id, text: 'redirect' }, 2_000);
    return id;
  };
  return { db, manual, transcript, state, writer, append, steer };
}

describe('ExternalTranscriptWriter', () => {
  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  it('writes one snapshot with the latest state for many accepted best-effort calls', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

    append(CHUNK);
    void writer.write();
    manual.fire();
    await tick();
    expect(db.writes).toHaveLength(1);

    for (let call = 0; call < 256; call++) {
      append(CHUNK);
      void writer.write();
    }
    manual.fire();
    await tick();
    // The held write blocks the trailing one: nothing has been serialized for it yet.
    expect(db.writes).toHaveLength(1);

    const flushed = writer.flush();
    db.releaseAll();
    await flushed;

    expect(db.writes).toHaveLength(2);
    expect(db.writes[1]?.text.length).toBe(CHUNK * 257);
  });

  it('accepts a burst inside one macrotask as a single wake-up', async () => {
    const { db, manual, writer, append } = setup();
    for (let call = 0; call < 50; call++) {
      append(CHUNK);
      void writer.write();
    }
    expect(manual.armed).toBe(1);

    manual.fire();
    await writer.flush();

    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.text.length).toBe(CHUNK * 50);
  });

  it('writes forced calls queued behind best-effort ones in order, never replaced', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

    append(CHUNK);
    void writer.write();
    manual.fire();
    await tick();
    append(CHUNK);
    void writer.write();
    manual.fire();

    append(10);
    const forced = writer.write({ force: true });
    append(10);
    const secondForced = writer.write({ force: true });
    db.releaseAll();
    await forced;
    await secondForced;
    await writer.flush();

    // The held first write, then each forced call as its own write: the dirty
    // best-effort snapshot they superseded produced none of its own.
    expect(db.writes.map((write) => write.text.length)).toEqual([
      CHUNK,
      CHUNK * 2 + 20,
      CHUNK * 2 + 20,
    ]);
  });

  it('never lets a stale snapshot land after newer state', async () => {
    const { db, manual, writer, append } = setup();
    db.hold();

    append(CHUNK);
    void writer.write();
    manual.fire();
    await tick();
    append(CHUNK);
    void writer.write();
    manual.fire();
    append(5);
    const forced = writer.write({ force: true });
    append(CHUNK);
    void writer.write();
    manual.fire();
    db.releaseAll();
    await forced;
    await writer.flush();

    const lengths = db.writes.map((write) => write.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths[lengths.length - 1]).toBe(CHUNK * 3 + 5);
  });

  it('keeps a flush barrier open until the required write that superseded its snapshot lands', async () => {
    const { db, manual, writer, append, steer } = setup();
    db.hold();

    append(CHUNK);
    void writer.write();
    manual.fire();
    await tick();
    // The first write is held. Accept newer state, flush it behind the held
    // write, then let a required write supersede that queued snapshot.
    append(CHUNK);
    void writer.write();
    let flushed = false;
    const flush = writer.flush().then(() => {
      flushed = true;
    });
    steer();
    const required = writer.writeRequired();

    db.releaseOldest();
    await tick();

    // The required write has started and is held: flush must still be waiting for it.
    expect({ flushed, writesStarted: db.writes.length, inFlight: db.inFlight.length }).toEqual({
      flushed: false,
      writesStarted: 2,
      inFlight: 1,
    });

    db.releaseAll();
    await flush;
    await required;
    expect(db.writes[db.writes.length - 1]).toMatchObject({
      text: 'x'.repeat(CHUNK * 2),
      steerStatus: 'accepted',
    });
  });

  it('flush starts the trailing write without waiting for the deferred wake-up', async () => {
    const { db, writer, append } = setup();
    append(CHUNK);
    void writer.write();
    expect(db.writes).toHaveLength(0);

    await writer.flush();

    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.text.length).toBe(CHUNK);
  });

  it('makes a wake-up that fires after a required write superseded its snapshot a no-op', async () => {
    const { db, manual, writer, append, steer } = setup();
    append(CHUNK);
    void writer.write();
    steer();
    await writer.writeRequired();

    manual.fire();
    await writer.flush();

    expect(db.writes).toHaveLength(1);
  });

  it('skips calls below the throttle without scheduling a write', async () => {
    const { db, manual, writer, append } = setup();
    append(CHUNK - 1);
    void writer.write();
    expect(manual.armed).toBe(0);
    manual.fire();
    await writer.flush();
    expect(db.writes).toHaveLength(0);
  });

  it('accepts a call once the time interval has elapsed', async () => {
    const { db, manual, state, writer, append } = setup();
    append(1);
    state.now += 1_000;
    void writer.write();
    manual.fire();
    await writer.flush();
    expect(db.writes.map((write) => write.text.length)).toEqual([1]);
  });

  it('keeps a failed best-effort write from blocking the next one', async () => {
    const { db, manual, writer, append } = setup();
    db.failNextWrite(new Error('disk full'));
    append(CHUNK);
    void writer.write();
    manual.fire();
    await writer.flush();

    append(CHUNK);
    void writer.write();
    manual.fire();
    await writer.flush();

    expect(db.writes.map((write) => write.text.length)).toEqual([CHUNK, CHUNK * 2]);
  });

  it('logs a failed forced write, resolves, and keeps later writes landing', async () => {
    const { db, writer, append } = setup();
    db.failNextWrite(new Error('disk full'));
    append(10);
    await expect(writer.write({ force: true })).resolves.toBeUndefined();

    append(10);
    await writer.write({ force: true });
    expect(db.writes.map((write) => write.text.length)).toEqual([10, 20]);
  });

  it('rejects a failed required write with the original error and keeps later writes landing', async () => {
    const { db, writer, append, steer } = setup();
    db.failNextWrite(new Error('disk full'));
    steer();

    await expect(writer.writeRequired()).rejects.toThrow('disk full');

    append(10);
    await writer.write({ force: true });
    expect(db.writes).toHaveLength(2);
  });

  it('runs the failure correction before any write queued behind the failed required write', async () => {
    const { db, manual, transcript, writer, append, steer } = setup();
    db.hold();
    const id = steer();
    const required = writer.writeRequired(() =>
      transcript.resolveSteerRejected(id, 'not-supported')
    );
    const outcome = required.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await tick();
    expect(db.inFlight).toHaveLength(1);

    // Accepted while the required write is in flight: its snapshot is taken
    // only once that write has failed and been corrected.
    append(CHUNK);
    void writer.write();
    manual.fire();
    const flushed = writer.flush();
    db.failOldest(new Error('disk full'));
    expect(await outcome).toBe('disk full');
    db.releaseAll();
    await flushed;

    expect(db.writes).toHaveLength(2);
    expect(db.writes[0]?.steerStatus).toBe('accepted');
    expect(db.writes[1]).toMatchObject({ text: 'x'.repeat(CHUNK), steerStatus: 'rejected' });
  });

  it('persists the deltas a failed required write absorbed, with its correction applied', async () => {
    const { db, manual, transcript, writer, append, steer } = setup();
    append(CHUNK);
    void writer.write();
    const id = steer();
    db.failNextWrite(new Error('disk full'));

    await expect(
      writer.writeRequired(() => transcript.resolveSteerRejected(id, 'turn-not-steerable'))
    ).rejects.toThrow('disk full');
    manual.fire();
    await writer.flush();

    // The required write took the dirty snapshot and failed. Nothing else
    // would have persisted the text, so a trailing write must.
    expect(db.writes).toHaveLength(2);
    expect(db.writes[1]).toMatchObject({ text: 'x'.repeat(CHUNK), steerStatus: 'rejected' });
  });
});

interface DurableRow {
  readonly text: string;
  readonly isGenerating: number;
  readonly parts: MessagePart[];
}

/** The real in-memory `messages` row for one generating external assistant turn. */
async function setupDurable(options: { defer?: (run: () => void) => void } = {}) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const messageId = crypto.randomUUID();
  const { transcript, append } = newTranscript();
  await insertMessage(
    {
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: true,
      interactionMode: 'agent',
      parts: JSON.stringify(transcript.parts),
    },
    getDb()
  );
  const writer = new ExternalTranscriptWriter(
    getDb(),
    messageId,
    transcript,
    Date.now,
    ...(options.defer ? [options.defer] : [])
  );
  const readRow = async (): Promise<DurableRow> => {
    const row = await getDb()
      .selectFrom('messages')
      .select(['text', 'parts', 'isGenerating'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    return {
      text: row.text,
      isGenerating: row.isGenerating,
      parts: JSON.parse(row.parts ?? '[]') as MessagePart[],
    };
  };
  const finalize = () =>
    getDb().updateTable('messages').set({ isGenerating: 0 }).where('id', '=', messageId).execute();
  return { transcript, writer, append, readRow, finalize };
}

describe('ExternalTranscriptWriter on SQLite', () => {
  it('lands the trailing write after a tick with the default wake-up', async () => {
    const { writer, append, readRow } = await setupDurable();
    append(CHUNK);
    void writer.write();
    // Accepted, not yet written: the default wake-up is a later macrotask.
    expect((await readRow()).text).toBe('');

    await tick();
    await writer.flush();

    const row = await readRow();
    expect(row.text).toHaveLength(CHUNK);
    expect(row.parts.some((part) => part.type === 'text')).toBe(true);
  });

  it('makes the trailing write a no-op once the turn is no longer generating', async () => {
    const { writer, append, readRow, finalize } = await setupDurable();
    append(CHUNK);
    void writer.write();
    // The turn is finalized before the wake-up fires; the `isGenerating = 1`
    // guard must keep the late snapshot from overwriting the final row.
    await finalize();

    await tick();
    await writer.flush();

    const row = await readRow();
    expect(row.isGenerating).toBe(0);
    expect(row.text).toBe('');
  });

  it('drains accepted text on flush when the turn ends before the wake-up fires', async () => {
    const manual = new ManualDefer();
    const { writer, append, readRow } = await setupDurable({ defer: manual.defer });
    for (let call = 0; call < 3; call++) {
      append(CHUNK);
      void writer.write();
    }
    expect((await readRow()).text).toBe('');

    await writer.flush();

    expect((await readRow()).text).toHaveLength(CHUNK * 3);
  });

  it('leaves the last forced state as the durable row when the turn crashes', async () => {
    const manual = new ManualDefer();
    const { writer, append, readRow } = await setupDurable({ defer: manual.defer });
    append(CHUNK);
    void writer.write();
    append(10);
    await writer.write({ force: true });
    const forced = await readRow();

    // Accepted after the last landed write, then the process dies: neither the
    // wake-up nor flush ever runs.
    append(CHUNK);
    void writer.write();

    expect(forced.text).toHaveLength(CHUNK + 10);
    expect(await readRow()).toEqual(forced);
  });
});
