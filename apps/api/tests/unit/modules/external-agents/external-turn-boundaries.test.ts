/**
 * The hard boundaries an external turn must never cross.
 *
 * A permanent, named suite rather than assertions scattered across feature
 * tests, so that deleting one is a visible act. Each test is numbered to the
 * rule it holds, and the invariant behind all of them is the same:
 *
 * > External agents never own MangoStudio tools. They use their own tools, and
 * > MangoStudio only surfaces them in the interface.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import {
  ExternalAgentEventSchema,
  ExternalAgentOpenParamsSchema,
  ExternalAgentTurnParamsSchema,
} from '@mangostudio/shared/external-agents';
import type { ExternalActivityPart, MessagePart } from '@mangostudio/shared/types';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../../src/db/database';
import {
  compactChatUseCase,
  ExternalChatCompactionUnsupportedError,
  summarizeToNewChatUseCase,
} from '../../../../src/modules/chats/application/context-compaction';
import { createExternalApprovalRegistry } from '../../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalSessionManager } from '../../../../src/modules/external-agents/application/external-session-manager';
import {
  createExternalTurnController,
  ExternalTurnRunnerMismatchError,
} from '../../../../src/modules/external-agents/application/external-turn-controller';
import {
  createFakeExternalRuntime,
  type FakeExternalRuntime,
} from '../../../support/external-agents/fake-external-runtime';
import { insertTestUser } from '../../../support/factories';

const API_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Anything that executes, schedules or authorizes a MangoStudio tool. Reachable
 * from the controller by *import* is already a violation: rules 1 through 4 are
 * about what the module can do at all, not about what one code path happened to
 * do during one test.
 */
const FORBIDDEN_MODULES = [
  'src/services/tools/registry.ts',
  'src/services/tools/builtin/',
  'src/services/tools/tool-runtime.ts',
  'src/modules/generation/application/standard-tool-execution.ts',
  'src/modules/generation/application/tool-execution-lifecycle.ts',
  'src/modules/generation/application/stream-text-turn.ts',
  'src/modules/generation/application/stream-text-turn-stages.ts',
  'src/modules/generation/application/resolve-agent-runtime.ts',
];

const EXTERNAL_AGENT_ENTRY_POINTS = [
  'src/modules/external-agents/application/external-turn-controller.ts',
  'src/modules/external-agents/application/external-session-manager.ts',
  'src/modules/external-agents/application/external-approval-registry.ts',
  'src/modules/external-agents/application/external-turn-recovery.ts',
];

/** Every module the entry points can reach, following relative imports. */
function importClosure(entryPoints: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = entryPoints.map((entry) => join(API_ROOT, entry));

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier) continue;
      const base = resolve(dirname(file), specifier);
      const candidate = [`${base}.ts`, join(base, 'index.ts')].find(
        (option) => existsSync(option) && option.endsWith('.ts')
      );
      if (candidate) stack.push(candidate);
    }
  }

  return [...seen].map((file) => file.slice(API_ROOT.length));
}

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

let userId = '';

async function insertExternalChat(options: { restrictToolsToWorkdir: number }): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      workdir: '/work/repo',
      environmentId: 'local',
      restrictToolsToWorkdir: options.restrictToolsToWorkdir,
    })
    .execute();
  return id;
}

function harness() {
  const runtime = createFakeExternalRuntime();
  const controller = createExternalTurnController({
    sessions: createExternalSessionManager({
      resolveRuntimeClient: () => Promise.resolve(runtime.client),
      newSessionId: () => `session-${crypto.randomUUID()}`,
    }),
    approvals: createExternalApprovalRegistry(),
  });
  return { runtime, controller };
}

async function waitForTurnStart(runtime: FakeExternalRuntime): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (runtime.calls.turn.length === 1) return;
    await new Promise((resolve_) => setTimeout(resolve_, 1));
  }
  throw new Error('Timed out waiting for the turn to reach the runtime');
}

function runTurn(controller: ReturnType<typeof harness>['controller'], chatId: string) {
  return controller.start(
    {
      userId,
      chatId,
      prompt: 'do the thing',
      configuration: CONFIGURATION,
      canonicalWorkspacePath: '/work/repo',
    },
    getDb()
  );
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
});

describe('external turn boundaries', () => {
  it('rule 0: the event contract has no member that could ask the hub to run a tool', () => {
    const types = ExternalAgentEventSchema.anyOf.map((member) => member.properties.type.const);

    // Every member is observational. Adding one that is not has to be a
    // deliberate edit to this list, in the same commit.
    expect([...types].sort()).toEqual([
      'activity_completed',
      'activity_started',
      'activity_updated',
      'approval_requested',
      'approval_resolved',
      'completed',
      'error',
      'reasoning_delta',
      'session_started',
      'text_delta',
      'usage',
    ]);
  });

  it('rules 1-4: the external turn modules cannot reach the tool executor at all', () => {
    const closure = importClosure(EXTERNAL_AGENT_ENTRY_POINTS);

    const violations = closure.filter((file) =>
      FORBIDDEN_MODULES.some((forbidden) => file.startsWith(forbidden))
    );
    expect(violations).toEqual([]);
  });

  it('rule 2: nothing but the closed parameter schemas crosses to the vendor', async () => {
    const { runtime, controller } = harness();
    const chatId = await insertExternalChat({ restrictToolsToWorkdir: 0 });
    const running = runTurn(controller, chatId);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'completed' });
    await running;

    // `additionalProperties: false` on both schemas is the enforcement; this
    // asserts the hub actually sends something the schema accepts, so no tool
    // definition, prompt or MangoStudio setting can ride along.
    for (const params of runtime.calls.open) {
      expect(Value.Check(ExternalAgentOpenParamsSchema, params)).toBe(true);
    }
    for (const params of runtime.calls.turn) {
      expect(Value.Check(ExternalAgentTurnParamsSchema, params)).toBe(true);
    }
  });

  it('rule 3: the workdir restriction setting changes nothing the vendor sees', async () => {
    const restricted = harness();
    const unrestricted = harness();
    const restrictedChat = await insertExternalChat({ restrictToolsToWorkdir: 1 });
    const unrestrictedChat = await insertExternalChat({ restrictToolsToWorkdir: 0 });

    const first = runTurn(restricted.controller, restrictedChat);
    await waitForTurnStart(restricted.runtime);
    restricted.runtime.emit({ type: 'completed' });
    await first;

    const second = runTurn(unrestricted.controller, unrestrictedChat);
    await waitForTurnStart(unrestricted.runtime);
    unrestricted.runtime.emit({ type: 'completed' });
    await second;

    const withoutIds = (params: { sessionId: string }) => ({ ...params, sessionId: '<minted>' });
    expect(restricted.runtime.calls.open.map(withoutIds)).toEqual(
      unrestricted.runtime.calls.open.map(withoutIds)
    );
    expect(restricted.runtime.calls.turn.map((params) => params.configuration)).toEqual(
      unrestricted.runtime.calls.turn.map((params) => params.configuration)
    );
  });

  it('rule 4: no iteration budget truncates the vendor loop', async () => {
    const { runtime, controller } = harness();
    const chatId = await insertExternalChat({ restrictToolsToWorkdir: 0 });
    const running = runTurn(controller, chatId);
    await waitForTurnStart(runtime);

    for (let index = 0; index < 50; index += 1) {
      runtime.emit({
        type: 'activity_started',
        callId: `call-${index}`,
        activity: { name: 'shell', kind: 'command', title: `step ${index}` },
      });
      runtime.emit({
        type: 'activity_completed',
        callId: `call-${index}`,
        result: { status: 'completed' },
      });
    }
    runtime.emit({ type: 'completed' });
    const result = await running;

    expect(result.reason).toBe('completed');
    const row = await getDb()
      .selectFrom('messages')
      .select('parts')
      .where('id', '=', result.assistantMessageId)
      .executeTakeFirstOrThrow();
    const parts = JSON.parse(row.parts ?? '[]') as MessagePart[];
    const activities = parts.filter(
      (part): part is ExternalActivityPart => part.type === 'external_activity'
    );
    expect(activities).toHaveLength(50);
    expect(activities.every((part) => part.status === 'completed')).toBe(true);
  });

  it('rule 5: no credential or environment injection reaches the vendor process', async () => {
    const { runtime, controller } = harness();
    const chatId = await insertExternalChat({ restrictToolsToWorkdir: 0 });
    const running = runTurn(controller, chatId);
    await waitForTurnStart(runtime);
    runtime.emit({ type: 'completed' });
    await running;

    expect(Object.keys(runtime.calls.open[0] ?? {}).sort()).toEqual([
      'configuration',
      'resumeMode',
      'sessionId',
      'targetId',
      'timeoutMs',
      'workspacePath',
    ]);
    expect(Object.keys(runtime.calls.turn[0] ?? {}).sort()).toEqual([
      'clientMessageId',
      'configuration',
      'input',
      'sessionId',
    ]);
  });

  it('rule 6: another user cannot start a turn on this chat', async () => {
    const { controller } = harness();
    const chatId = await insertExternalChat({ restrictToolsToWorkdir: 0 });
    const stranger = await insertTestUser();

    await expect(
      controller.start(
        {
          userId: stranger.id,
          chatId,
          prompt: 'do the thing',
          configuration: CONFIGURATION,
          canonicalWorkspacePath: '/work/repo',
        },
        getDb()
      )
    ).rejects.toBeInstanceOf(ExternalTurnRunnerMismatchError);
  });

  it('rule 7: a MangoStudio chat cannot run an external turn', async () => {
    const { controller } = harness();
    const internalChatId = `chat-${crypto.randomUUID()}`;
    await getDb()
      .insertInto('chats')
      .values({
        id: internalChatId,
        title: 'internal chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId,
        runnerKind: 'mangostudio',
        runnerAgentId: 'default',
        workdir: '/work/repo',
        environmentId: 'local',
      })
      .execute();

    await expect(runTurn(controller, internalChatId)).rejects.toBeInstanceOf(
      ExternalTurnRunnerMismatchError
    );
  });

  it('compaction refuses a chat MangoStudio does not own the context of', async () => {
    const chatId = await insertExternalChat({ restrictToolsToWorkdir: 0 });

    await expect(compactChatUseCase({ chatId, userId }, getDb())).rejects.toBeInstanceOf(
      ExternalChatCompactionUnsupportedError
    );
    await expect(summarizeToNewChatUseCase({ chatId, userId }, getDb())).rejects.toBeInstanceOf(
      ExternalChatCompactionUnsupportedError
    );
  });
});
