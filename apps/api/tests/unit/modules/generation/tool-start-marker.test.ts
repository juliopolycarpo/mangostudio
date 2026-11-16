/**
 * A tool that is not a plain read must not start before the durable `running`
 * marker that records it is committed. The executor waits on the
 * `beforeToolStart` hook, which `createToolStartMarkerWriter` backs with a durable
 * checkpoint. These tests run the real executor and the real checkpoint writer
 * against a store that records the order of commits and tool starts.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import {
  executeStandardToolCallsWithProgress,
  type ToolExecutionProgressItem,
} from '../../../../src/modules/generation/application/standard-tool-execution';
import {
  createToolStartMarkerWriter,
  synchronizeToolProgressForCheckpoint,
} from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import {
  type CheckpointWriteOptions,
  createTurnCheckpointPart,
  type TurnCheckpointStore,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import {
  type CheckpointDelta,
  type CheckpointedContent,
  foldCheckpointDeltas,
} from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';
import { waitUntil } from '../../../support/wait-until';

const MUTATING_TOOL = 'write_file';
const READ_ONLY_TOOL = 'read_file';

/** Ordered record of everything the test cares about: commits and tool starts. */
class EventLog {
  readonly entries: string[] = [];
  push(entry: string): void {
    this.entries.push(entry);
  }
}

/**
 * Named fake for the checkpoint store. It logs a commit as
 * `commit(durable|plain):<running call ids>` once the write lands, keeps the
 * folded state a reader would see, can hold writes until released, and can fail
 * the next write.
 */
class OrderRecordingStore implements TurnCheckpointStore {
  private stored: CheckpointedContent = {
    text: '',
    parts: [],
    providerState: null,
    generationTime: null,
  };
  private holding = false;
  private commitDelayMs = 0;
  private readonly held: Array<() => void> = [];
  private failure: Error | null = null;

  constructor(private readonly log: EventLog) {}

  hold(): void {
    this.holding = true;
  }

  /** Makes every write take `ms` to land, as a busy disk does. */
  slowCommits(ms: number): void {
    this.commitDelayMs = ms;
  }

  releaseOldest(): void {
    this.held.shift()?.();
  }

  releaseAll(): void {
    this.holding = false;
    while (this.held.length > 0) this.releaseOldest();
  }

  failNextWrite(error: Error): void {
    this.failure = error;
  }

  get heldCount(): number {
    return this.held.length;
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
    return this.commit(
      {
        text: row.text,
        parts: JSON.parse(row.partsJson) as MessagePart[],
        providerState: row.providerState,
        generationTime: row.generationTime ?? null,
      },
      options
    );
  }

  appendDelta(_seq: number, deltaJson: string, options: CheckpointWriteOptions): Promise<void> {
    return this.commit(
      foldCheckpointDeltas(this.stored, [JSON.parse(deltaJson) as CheckpointDelta]),
      options
    );
  }

  private commit(next: CheckpointedContent, options: CheckpointWriteOptions): Promise<void> {
    const failure = this.failure;
    this.failure = null;
    if (failure) return Promise.reject(failure);
    const land = () => {
      this.stored = next;
      const running = next.parts.flatMap((part) =>
        part.type === 'tool_call' && part.execution?.status === 'running' ? [part.toolCallId] : []
      );
      this.log.push(`commit(${options.durable ? 'durable' : 'plain'}):${running.join(',')}`);
    };
    if (this.commitDelayMs > 0) {
      return new Promise((resolve) => {
        setTimeout(() => {
          land();
          resolve();
        }, this.commitDelayMs);
      });
    }
    if (!this.holding) {
      land();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.held.push(() => {
        land();
        resolve();
      });
    });
  }
}

function snapshotRegistry(): RegisteredTool[] {
  return getAllTools().map((tool) => ({
    definition: { ...tool.definition },
    settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
    execute: tool.execute,
    buildDefinition: tool.buildDefinition,
  }));
}

/** `gate`, when given, keeps the tool running until it settles. */
function logsWhenExecuted(name: string, log: EventLog, gate?: Promise<void>): RegisteredTool {
  return {
    definition: { name, description: `Records that ${name} started`, parameters: {} },
    settings: {
      title: name,
      description: `Records that ${name} started`,
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: async (args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      log.push(`tool:${name}:${id}`);
      if (gate) {
        await gate;
        log.push(`tool-end:${name}:${id}`);
      }
      return { ok: true };
    },
  };
}

function createHarness() {
  const log = new EventLog();
  const store = new OrderRecordingStore(log);
  const checkpoint = createTurnCheckpointPart({
    turnId: 'turn-marker',
    startedAt: 1_000,
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
  const session = {
    allParts: [checkpoint] as MessagePart[],
    checkpointWriter: null as unknown as TurnCheckpointWriter,
  };
  session.checkpointWriter = new TurnCheckpointWriter({
    store,
    chatId: 'chat-marker',
    messageId: 'turn-marker',
    checkpoint,
    getContent: () => ({ text: '', parts: session.allParts, providerState: null }),
  });
  /** Like the provider stage: each call has a tool_call part before it is executed. */
  const announce = (callId: string, name: string) => {
    session.allParts.push({
      type: 'tool_call',
      toolCallId: callId,
      name,
      args: {},
      execution: { status: 'queued', source: 'builtin', queuedAt: 1 },
    });
  };
  /**
   * `consumeLikeTurn` adds what the turn does with every progress item: project it into the
   * parts and write a forced checkpoint, which is slower than the executor and so falls behind it.
   */
  const run = async (
    calls: Array<[callId: string, name: string]>,
    signal?: AbortSignal,
    options: { consumeLikeTurn?: boolean } = {}
  ): Promise<ToolExecutionProgressItem[]> => {
    for (const [callId, name] of calls) announce(callId, name);
    const items: ToolExecutionProgressItem[] = [];
    for await (const item of executeStandardToolCallsWithProgress(
      calls.map(([callId, name]) => [callId, { name, argsStr: JSON.stringify({ id: callId }) }]),
      {
        userId: 'user-marker',
        chatId: 'chat-marker',
        environmentId: 'local',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([MUTATING_TOOL, READ_ONLY_TOOL]),
        signal,
        beforeToolStart: createToolStartMarkerWriter(session),
      }
    )) {
      items.push(item);
      if (options.consumeLikeTurn) {
        synchronizeToolProgressForCheckpoint(item, session.allParts);
        await session.checkpointWriter.checkpoint({ force: true });
      }
    }
    return items;
  };
  return { log, store, session, run };
}

const executionOf = (items: ToolExecutionProgressItem[], callId: string) => {
  const found = items.find((item) => item.kind === 'execution' && item.execution.callId === callId);
  if (found?.kind !== 'execution') {
    throw new Error(`expected an execution item for ${callId} | received ${items.length} items`);
  }
  return found.execution;
};

describe('tool start marker', () => {
  let registrySnapshot: RegisteredTool[];
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
    harness = createHarness();
    registrySnapshot = snapshotRegistry();
    clearRegistry();
    registerTool(logsWhenExecuted(MUTATING_TOOL, harness.log));
    registerTool(logsWhenExecuted(READ_ONLY_TOOL, harness.log));
  });

  afterEach(() => {
    clearRegistry();
    for (const tool of registrySnapshot) registerTool(tool);
    mock.restore();
  });

  it('starts a mutating tool only after its durable running marker is committed', async () => {
    harness.store.hold();
    const finished = harness.run([['call-1', MUTATING_TOOL]]);

    await waitUntil(
      () => harness.store.heldCount > 0,
      'the running marker write to be in flight',
      2_000
    );
    // The marker is still being written: the tool must not have started.
    await Bun.sleep(30);
    expect(harness.log.entries).toEqual([]);

    harness.store.releaseAll();
    await finished;

    expect(harness.log.entries.slice(0, 2)).toEqual([
      'commit(durable):call-1',
      `tool:${MUTATING_TOOL}:call-1`,
    ]);
  });

  it('does not make a read-only tool wait for, or write, a marker', async () => {
    harness.store.hold();

    const items = await harness.run([['call-read', READ_ONLY_TOOL]]);

    expect(harness.store.heldCount).toBe(0);
    expect(harness.log.entries).toEqual([`tool:${READ_ONLY_TOOL}:call-read`]);
    expect(executionOf(items, 'call-read').isError).toBe(false);
  });

  it('does not start a mutating tool whose marker could not be written', async () => {
    harness.store.failNextWrite(new Error('disk full'));

    const items = await harness.run([['call-1', MUTATING_TOOL]]);

    expect(harness.log.entries).toEqual([]);
    const execution = executionOf(items, 'call-1');
    expect(execution.isError).toBe(true);
    expect((JSON.parse(execution.resultStr) as { error: string }).error).toContain(
      `Tool "${MUTATING_TOOL}" was not started`
    );
    expect(execution.execution).toMatchObject({ status: 'failed', reasonCode: 'execution_error' });
  });

  it('does not start a mutating tool cancelled while its marker is being written', async () => {
    const controller = new AbortController();
    harness.store.hold();
    const finished = harness.run([['call-1', MUTATING_TOOL]], controller.signal);

    await waitUntil(
      () => harness.store.heldCount > 0,
      'the running marker write to be in flight',
      2_000
    );
    controller.abort();
    harness.store.releaseAll();
    const items = await finished;

    expect(harness.log.entries).toEqual(['commit(durable):call-1']);
    expect(executionOf(items, 'call-1').execution).toMatchObject({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
  });

  it('does not write a marker for a turn that was cancelled before the call began', async () => {
    const controller = new AbortController();
    controller.abort();

    const items = await harness.run([['call-1', MUTATING_TOOL]], controller.signal);

    expect(harness.log.entries).toEqual([]);
    expect(executionOf(items, 'call-1').execution.status).toBe('cancelled');
  });

  it('gives each parallel mutating call its own marker and lets reads run past them', async () => {
    harness.store.hold();
    const finished = harness.run([
      ['call-a', MUTATING_TOOL],
      ['call-read', READ_ONLY_TOOL],
      ['call-b', MUTATING_TOOL],
    ]);

    // The read-only call is not queued behind the held marker writes.
    await waitUntil(
      () => harness.log.entries.includes(`tool:${READ_ONLY_TOOL}:call-read`),
      'the read-only call to start while markers are held'
    );
    expect(harness.log.entries).toEqual([`tool:${READ_ONLY_TOOL}:call-read`]);

    // Release every write as it reaches the store; a deadlock would hit the deadline here.
    const releasing = setInterval(() => harness.store.releaseAll(), 5);
    try {
      await Promise.race([
        finished,
        Bun.sleep(5_000).then(() => {
          throw new Error(
            `expected both mutating calls to finish | received a hang with log ${JSON.stringify(harness.log.entries)}`
          );
        }),
      ]);
    } finally {
      clearInterval(releasing);
    }

    const { entries } = harness.log;
    for (const callId of ['call-a', 'call-b']) {
      const started = entries.indexOf(`tool:${MUTATING_TOOL}:${callId}`);
      const marker = entries.findIndex(
        (entry) => entry.startsWith('commit(durable):') && entry.split(':')[1]?.includes(callId)
      );
      expect(marker).toBeGreaterThanOrEqual(0);
      expect(started).toBeGreaterThan(marker);
    }
    // One durable commit per mutating call: no fsync for the read.
    expect(entries.filter((entry) => entry.startsWith('commit(durable)'))).toHaveLength(2);
  });

  it('never stores a running call as queued while the turn works through its backlog', async () => {
    // The executor announces every call as queued and moves on; the turn writes one checkpoint per
    // item, so it is still on the queued items when the first calls have already started. A queued
    // snapshot that lands after the running marker must not put the call back to queued.
    let releaseTools!: () => void;
    const toolsMayFinish = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    clearRegistry();
    registerTool(logsWhenExecuted(MUTATING_TOOL, harness.log, toolsMayFinish));
    harness.store.slowCommits(3);
    const calls: Array<[string, string]> = [
      ['call-a', MUTATING_TOOL],
      ['call-b', MUTATING_TOOL],
      ['call-c', MUTATING_TOOL],
    ];
    const finished = harness.run(calls, undefined, { consumeLikeTurn: true });

    await waitUntil(
      () => calls.every(([id]) => harness.log.entries.includes(`tool:${MUTATING_TOOL}:${id}`)),
      'every call to start',
      5_000
    );
    // Let the turn drain its backlog while the tools are still running.
    await Bun.sleep(150);
    releaseTools();
    await finished;

    const { entries } = harness.log;
    for (const [callId] of calls) {
      const marker = entries.findIndex(
        (entry) => entry.startsWith('commit(durable):') && entry.split(':')[1]?.includes(callId)
      );
      const end = entries.indexOf(`tool-end:${MUTATING_TOOL}:${callId}`);
      expect(marker).toBeGreaterThanOrEqual(0);
      const notRunning = entries
        .slice(marker, end)
        .filter((entry) => entry.startsWith('commit(') && !entry.split(':')[1]?.includes(callId));
      expect(
        notRunning,
        `expected every commit between ${callId}'s marker and its end to list it as running | received ${JSON.stringify(notRunning)}`
      ).toEqual([]);
    }
  });
});

describe('synchronizeToolProgressForCheckpoint', () => {
  const part = (status: 'queued' | 'running'): MessagePart => ({
    type: 'tool_call',
    toolCallId: 'call-1',
    name: MUTATING_TOOL,
    args: { path: 'a.txt' },
    execution: { status, source: 'builtin', queuedAt: 1 },
  });
  const transition = (status: 'queued' | 'running'): ToolExecutionProgressItem => ({
    kind: 'event',
    event: {
      type: 'tool_execution',
      callId: 'call-1',
      name: MUTATING_TOOL,
      execution: { status, source: 'builtin', queuedAt: 1 },
    },
  });

  it('does not put a call that is already running back to queued', () => {
    const parts = [part('running')];

    synchronizeToolProgressForCheckpoint(transition('queued'), parts);

    expect(parts).toEqual([part('running')]);
  });

  it('still moves a queued call to running and keeps its args', () => {
    const parts = [part('queued')];

    synchronizeToolProgressForCheckpoint(transition('running'), parts);

    expect(parts).toEqual([part('running')]);
  });
});
