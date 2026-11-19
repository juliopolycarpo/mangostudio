/**
 * A tool that is not a plain read must not start before the durable `running`
 * marker that records it is committed. The executor waits on the
 * `beforeToolStart` hook, which `createToolStartMarkerWriter` backs with a durable
 * checkpoint. These tests run the real executor and the real checkpoint writer
 * against a store that records the order of commits and tool starts.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../../src/db/types';
import {
  executeStandardToolCallsWithProgress,
  type StandardToolExecutionContext,
  type ToolExecutionProgressItem,
} from '../../../../src/modules/generation/application/standard-tool-execution';
import {
  createToolStartMarkerWriter,
  synchronizeToolProgressForCheckpoint,
} from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import * as realSubagentRunner from '../../../../src/modules/generation/application/subagent-runner';
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
import * as realToolBridge from '../../../../src/services/mcp/tool-bridge';
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
  private readonly held: Array<() => void> = [];
  private failure: Error | null = null;

  constructor(private readonly log: EventLog) {}

  hold(): void {
    this.holding = true;
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
      // The read-only fixture declares what the real `read_file` declares; the
      // marker is skipped for a tool the registry says is a read.
      ...(name === READ_ONLY_TOOL ? { retrySafety: 'safe_read' as const } : {}),
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
  const consumed = { items: 0 };
  const run = async (
    calls: Array<[callId: string, name: string]>,
    signal?: AbortSignal,
    options: {
      consumeLikeTurn?: boolean;
      context?: Partial<StandardToolExecutionContext>;
      /** Arguments for a call; the default carries only its id. */
      argsFor?: (callId: string) => Record<string, unknown>;
    } = {}
  ): Promise<ToolExecutionProgressItem[]> => {
    for (const [callId, name] of calls) announce(callId, name);
    const items: ToolExecutionProgressItem[] = [];
    for await (const item of executeStandardToolCallsWithProgress(
      calls.map(([callId, name]) => [
        callId,
        { name, argsStr: JSON.stringify(options.argsFor?.(callId) ?? { id: callId }) },
      ]),
      {
        userId: 'user-marker',
        chatId: 'chat-marker',
        environmentId: 'local',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([MUTATING_TOOL, READ_ONLY_TOOL]),
        signal,
        beforeToolStart: createToolStartMarkerWriter(session),
        ...options.context,
      }
    )) {
      items.push(item);
      if (options.consumeLikeTurn) {
        synchronizeToolProgressForCheckpoint(item, session.allParts);
        await session.checkpointWriter.checkpoint({ force: true });
      }
      consumed.items += 1;
    }
    return items;
  };
  return { log, store, session, run, consumed };
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
    // item, so it is still on the queued items when the calls have already started. A queued
    // snapshot that lands after the running marker must not put the call back to queued.
    // Every write is held and released one at a time, so the turn is provably behind the executor
    // (not just slow) and the interleaving does not depend on timing.
    let releaseTools!: () => void;
    const toolsMayFinish = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    clearRegistry();
    registerTool(logsWhenExecuted(MUTATING_TOOL, harness.log, toolsMayFinish));
    harness.store.hold();
    const calls: Array<[string, string]> = [
      ['call-a', MUTATING_TOOL],
      ['call-b', MUTATING_TOOL],
      ['call-c', MUTATING_TOOL],
    ];
    const finished = harness.run(calls, undefined, { consumeLikeTurn: true });

    // Three queued items and three running items arrive before the tools may finish.
    const itemsBeforeToolsFinish = calls.length * 2;
    while (harness.consumed.items < itemsBeforeToolsFinish) {
      await waitUntil(
        () => harness.store.heldCount > 0 || harness.consumed.items >= itemsBeforeToolsFinish,
        `a checkpoint write or ${itemsBeforeToolsFinish} consumed items`,
        5_000,
        () => `consumed ${harness.consumed.items}, log ${JSON.stringify(harness.log.entries)}`
      );
      harness.store.releaseOldest();
    }
    expect(
      calls.every(([id]) => harness.log.entries.includes(`tool:${MUTATING_TOOL}:${id}`)),
      `expected every call to have started | received log ${JSON.stringify(harness.log.entries)}`
    ).toBe(true);
    releaseTools();
    harness.store.releaseAll();
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

/**
 * The tool kinds that do not go through the builtin branch of the executor. Each is a call that
 * is not a plain read, so each must wait for its marker; a hook placed inside the builtin branch
 * alone would let these start unrecorded.
 */
describe('tool start marker for MCP and delegated calls', () => {
  const MCP_TOOL = 'mcp__fixture__push';
  const DELEGATE_TOOL = 'delegate_to_agent';
  let registrySnapshot: RegisteredTool[];
  let harness: ReturnType<typeof createHarness>;

  /** Named fake for the MCP lookup: the server row exists and the call is logged when it runs. */
  const installMcpBridgeWithFixtureServer = (log: EventLog) => {
    spyOn(realToolBridge, 'resolveMcpToolExecution').mockImplementation((_db, userId, name) =>
      Promise.resolve({
        parsed: { serverSlug: 'fixture', toolName: name.replace('mcp__fixture__', '') },
        server: { id: 'server-fixture', userId, slug: 'fixture' } as never,
      })
    );
    spyOn(realToolBridge, 'executeResolvedMcpTool').mockImplementation((_userId, _target, args) => {
      log.push(`tool:${MCP_TOOL}:${typeof args.id === 'string' ? args.id : ''}`);
      return Promise.resolve({ content: [], contentText: 'pushed', isError: false } as never);
    });
  };

  /** Named fake for the subagent run a delegation starts. */
  const installSubagentRunnerThatLogs = (log: EventLog) => {
    spyOn(realSubagentRunner, 'runSubagentTurn').mockImplementation((input) => {
      log.push(`tool:${DELEGATE_TOOL}:${input.request.task}`);
      return Promise.resolve({
        agentId: 'explore',
        agentName: 'Explore',
        status: 'completed',
        summary: 'done',
        messages: [],
        toolCallCount: 0,
        tools: [],
        durationMs: 1,
        trace: { type: 'subagent_trace', messages: [], tools: [] },
      } as never);
    });
  };

  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => undefined);
    harness = createHarness();
    registrySnapshot = snapshotRegistry();
    clearRegistry();
    registerTool(logsWhenExecuted(DELEGATE_TOOL, harness.log));
    installMcpBridgeWithFixtureServer(harness.log);
    installSubagentRunnerThatLogs(harness.log);
  });

  afterEach(() => {
    clearRegistry();
    for (const tool of registrySnapshot) registerTool(tool);
    mock.restore();
  });

  const mcpContext = (): Partial<StandardToolExecutionContext> => ({
    db: {} as Kysely<Database>,
    allowedToolNames: new Set([MCP_TOOL]),
  });

  const delegationContext = (): Partial<StandardToolExecutionContext> => ({
    allowedToolNames: new Set([DELEGATE_TOOL]),
    delegationRuntime: {
      db: {} as Kysely<Database>,
      userId: 'user-marker',
      chatId: 'chat-marker',
      environmentId: 'local',
      parentAgentProfile: { id: 'default' } as never,
      parentModelName: 'gpt-test',
      settings: {
        enabled: true,
        traceVisibility: 'off',
        maxDepth: 1,
        maxSubagentCalls: 3,
        timeoutMs: 5_000,
        defaultMaxTurns: 3,
      },
      state: { subagentCallCount: 0 },
    },
  });

  it('starts an MCP tool only after its durable running marker is committed', async () => {
    harness.store.hold();
    const finished = harness.run([['call-mcp', MCP_TOOL]], undefined, { context: mcpContext() });

    await waitUntil(
      () => harness.store.heldCount > 0,
      'the MCP call to wait on its marker write',
      2_000
    );
    await Bun.sleep(30);
    expect(harness.log.entries).toEqual([]);

    harness.store.releaseAll();
    await finished;

    expect(harness.log.entries.slice(0, 2)).toEqual([
      'commit(durable):call-mcp',
      `tool:${MCP_TOOL}:call-mcp`,
    ]);
  });

  it('does not start an MCP tool whose marker could not be written', async () => {
    harness.store.failNextWrite(new Error('disk full'));

    const items = await harness.run([['call-mcp', MCP_TOOL]], undefined, {
      context: mcpContext(),
    });

    expect(harness.log.entries).toEqual([]);
    expect(executionOf(items, 'call-mcp').isError).toBe(true);
  });

  it('starts a delegation only after its durable running marker is committed', async () => {
    harness.store.hold();
    const finished = harness.run([['call-delegate', DELEGATE_TOOL]], undefined, {
      context: delegationContext(),
      argsFor: () => ({ agentId: 'explore', task: 'call-delegate' }),
    });

    await waitUntil(
      () => harness.store.heldCount > 0,
      'the delegation to wait on its marker write',
      2_000
    );
    await Bun.sleep(30);
    expect(harness.log.entries).toEqual([]);

    harness.store.releaseAll();
    await finished;

    expect(harness.log.entries.slice(0, 2)).toEqual([
      'commit(durable):call-delegate',
      `tool:${DELEGATE_TOOL}:call-delegate`,
    ]);
  });

  it('does not start a delegation whose marker could not be written', async () => {
    harness.store.failNextWrite(new Error('disk full'));

    const items = await harness.run([['call-delegate', DELEGATE_TOOL]], undefined, {
      context: delegationContext(),
      argsFor: () => ({ agentId: 'explore', task: 'call-delegate' }),
    });

    expect(harness.log.entries).toEqual([]);
    expect(executionOf(items, 'call-delegate').isError).toBe(true);
  });
});
