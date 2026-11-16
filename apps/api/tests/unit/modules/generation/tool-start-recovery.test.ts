/**
 * Recovery after a kill between a mutating tool starting and its result: the
 * stored turn must say the call started, so recovery asks the model to verify it
 * and does not offer it as never run. The "kill" is the moment the tool body is
 * entered: the test runs the startup reconcile pass against the database as it
 * stands then, which is all a restarted hub would have.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { isTurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import {
  createToolStartMarkerWriter,
  synchronizeToolProgressForCheckpoint,
} from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import {
  createDatabaseCheckpointStore,
  createTurnCheckpointPart,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import { reconcileStaleTurns } from '../../../../src/modules/generation/application/turn-recovery';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { clearRegistry, getAllTools, registerTool } from '../../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../../src/services/tools/types';
import { insertTestChat, insertTestUser } from '../../../support/factories';

const CALL_ID = 'call-push';
const TOOL_NAME = 'write_file';

describe('recovery of a mutating tool killed before its result', () => {
  let registrySnapshot: RegisteredTool[];

  beforeEach(() => {
    registrySnapshot = getAllTools().map((tool) => ({
      definition: { ...tool.definition },
      settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
      execute: tool.execute,
      buildDefinition: tool.buildDefinition,
    }));
  });

  afterEach(() => {
    clearRegistry();
    for (const tool of registrySnapshot) registerTool(tool);
  });

  it('reports the call as started with an unknown outcome, not as interrupted before it ran', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const messageId = crypto.randomUUID();
    const checkpoint = createTurnCheckpointPart({
      turnId: messageId,
      startedAt: Date.now(),
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'default',
    });
    const allParts: MessagePart[] = [
      checkpoint,
      {
        type: 'tool_call',
        toolCallId: CALL_ID,
        name: TOOL_NAME,
        args: { path: 'a.txt' },
        execution: { status: 'queued', source: 'builtin', queuedAt: 1 },
      },
    ];
    await insertMessage(
      {
        id: messageId,
        chatId: chat.id,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: true,
        interactionMode: 'agent',
        parts: JSON.stringify(allParts),
      },
      getDb()
    );
    const session = {
      allParts,
      checkpointWriter: new TurnCheckpointWriter({
        store: createDatabaseCheckpointStore(getDb(), messageId),
        chatId: chat.id,
        messageId,
        checkpoint,
        getContent: () => ({ text: '', parts: allParts, providerState: null }),
      }),
    };

    let recoveredAtToolStart: MessagePart[] | undefined;
    clearRegistry();
    registerTool({
      definition: { name: TOOL_NAME, description: 'Stands in for a write', parameters: {} },
      settings: {
        title: TOOL_NAME,
        description: 'Stands in for a write',
        category: 'system',
        enabledByDefault: true,
        canDisable: true,
        defaultParameters: {},
        parameterDescriptors: [],
      },
      execute: async () => {
        // The hub dies here: the tool has started, no result was stored. A restart
        // reads exactly what the database holds at this moment.
        await reconcileStaleTurns({ chatId: chat.id, reasonCode: 'server_restart' }, getDb());
        const row = await getDb()
          .selectFrom('messages')
          .select('parts')
          .where('id', '=', messageId)
          .executeTakeFirstOrThrow();
        recoveredAtToolStart = JSON.parse(row.parts ?? '[]') as MessagePart[];
        return { ok: true };
      },
    });

    // The turn's own consumer loop: it checkpoints progress as it arrives, off the
    // executor's hot path, which is why it cannot be what orders the marker.
    for await (const item of executeStandardToolCallsWithProgress(
      [[CALL_ID, { name: TOOL_NAME, argsStr: JSON.stringify({ path: 'a.txt' }) }]],
      {
        userId: user.id,
        chatId: chat.id,
        environmentId: 'local',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([TOOL_NAME]),
        beforeToolStart: createToolStartMarkerWriter(session),
      }
    )) {
      synchronizeToolProgressForCheckpoint(item, allParts);
      await session.checkpointWriter.checkpoint({ force: true });
    }

    const recoveredCheckpoint = recoveredAtToolStart?.find(isTurnCheckpointPart);
    expect(recoveredCheckpoint?.status).toBe('interrupted');
    expect(recoveredCheckpoint?.incompleteCalls).toEqual([
      expect.objectContaining({
        callId: CALL_ID,
        name: TOOL_NAME,
        // Recovery cancels what it finds; the reason is what says the call had started.
        status: 'cancelled',
        outcome: 'unknown',
      }),
    ]);
    const recoveredCall = recoveredAtToolStart?.find(
      (part) => part.type === 'tool_call' && part.toolCallId === CALL_ID
    );
    expect(recoveredCall?.type === 'tool_call' && recoveredCall.execution?.reasonCode).toBe(
      'outcome_unknown'
    );
  });
});

describe('a start marker for a turn that was already finalized', () => {
  let registrySnapshot: RegisteredTool[];
  let toolStarts: string[];

  beforeEach(() => {
    toolStarts = [];
    registrySnapshot = getAllTools().map((tool) => ({
      definition: { ...tool.definition },
      settings: { ...tool.settings, parameterDescriptors: [...tool.settings.parameterDescriptors] },
      execute: tool.execute,
      buildDefinition: tool.buildDefinition,
    }));
    clearRegistry();
    registerTool({
      definition: { name: TOOL_NAME, description: 'Stands in for a write', parameters: {} },
      settings: {
        title: TOOL_NAME,
        description: 'Stands in for a write',
        category: 'system',
        enabledByDefault: true,
        canDisable: true,
        defaultParameters: {},
        parameterDescriptors: [],
      },
      execute: () => {
        toolStarts.push(TOOL_NAME);
        return Promise.resolve({ ok: true });
      },
    });
  });

  afterEach(() => {
    clearRegistry();
    for (const tool of registrySnapshot) registerTool(tool);
  });

  /** A turn whose message row was already finalized, as after a stop or a restart reconcile. */
  async function finalizedTurn() {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const messageId = crypto.randomUUID();
    const checkpoint = createTurnCheckpointPart({
      turnId: messageId,
      startedAt: Date.now(),
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'default',
    });
    const allParts: MessagePart[] = [
      checkpoint,
      {
        type: 'tool_call',
        toolCallId: CALL_ID,
        name: TOOL_NAME,
        args: {},
        execution: { status: 'queued', source: 'builtin', queuedAt: 1 },
      },
    ];
    await insertMessage(
      {
        id: messageId,
        chatId: chat.id,
        role: 'ai',
        text: '',
        timestamp: Date.now(),
        isGenerating: false,
        interactionMode: 'agent',
        parts: JSON.stringify([checkpoint]),
      },
      getDb()
    );
    const session = {
      allParts,
      checkpointWriter: new TurnCheckpointWriter({
        store: createDatabaseCheckpointStore(getDb(), messageId),
        chatId: chat.id,
        messageId,
        checkpoint,
        getContent: () => ({ text: '', parts: allParts, providerState: null }),
      }),
    };
    return { user, chat, messageId, session };
  }

  it('does not start a mutating tool, since its marker was stored nowhere', async () => {
    const { user, chat, session } = await finalizedTurn();

    const items = [];
    for await (const item of executeStandardToolCallsWithProgress(
      [[CALL_ID, { name: TOOL_NAME, argsStr: '{}' }]],
      {
        userId: user.id,
        chatId: chat.id,
        environmentId: 'local',
        settingsByToolName: new Map(),
        allowedToolNames: new Set([TOOL_NAME]),
        beforeToolStart: createToolStartMarkerWriter(session),
      }
    )) {
      items.push(item);
    }

    expect(toolStarts).toEqual([]);
    const execution = items.find((item) => item.kind === 'execution');
    expect(execution?.kind === 'execution' && execution.execution.resultStr).toContain(
      `Tool \\"${TOOL_NAME}\\" was not started`
    );
  });

  it('reports a durable checkpoint on a finalized row as not stored, and a plain one as harmless', async () => {
    const { session, messageId } = await finalizedTurn();
    const before = await getDb()
      .selectFrom('messages')
      .select(['parts', 'isGenerating'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();

    // The first checkpoint is a rewrite, the second a delta; both kinds must be refused.
    const durableRewrite = await session.checkpointWriter.checkpoint({
      force: true,
      durable: true,
    });
    const durableDelta = await session.checkpointWriter.checkpoint({ force: true, durable: true });
    // A text checkpoint that loses the race with finalization is not an error.
    const plain = await session.checkpointWriter.checkpoint({ force: true });

    expect(durableRewrite).toBe(false);
    expect(durableDelta).toBe(false);
    expect(plain).toBe(true);
    const after = await getDb()
      .selectFrom('messages')
      .select(['parts', 'isGenerating'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });
});
