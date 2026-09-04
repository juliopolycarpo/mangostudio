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
import Value from 'typebox/value';
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

/**
 * Every relative specifier a module reaches, in all three forms.
 *
 * Not just `from './x'`: a side-effect import (`import './x'`) and a dynamic
 * one (`import('./x')`) reach a module exactly as well, and a graph that
 * followed only the first would let an external turn module pull in the tool
 * executor while the boundary suite still passed. Over-matching is safe here —
 * an extra edge can only make a "cannot reach" assertion stricter.
 */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** Every module the entry points can reach, following relative imports. */
function importClosure(entryPoints: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = entryPoints.map((entry) => join(API_ROOT, entry));

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
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

/** The graph is only as strong as the edges it can see. */
function relativeImportsIn(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].flatMap((match) => match[1] ?? []);
}

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
      credentialHomeFingerprint: 'sha256:home-a',
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
      'account_limits',
      'activity_completed',
      'activity_started',
      'activity_updated',
      'approval_requested',
      'approval_resolved',
      // Observational like the rest: the vendor saying it stopped the turn
      // early. It asks the hub for nothing and has no payload to ask with.
      'cancelled',
      // Names the user may type. It asks the hub to run nothing, and the hub
      // does not resolve one — the vendor expands it on the next prompt.
      'commands_available',
      'completed',
      'error',
      'reasoning_delta',
      'reasoning_ended',
      'reasoning_started',
      'session_started',
      'text_delta',
      'thread_usage',
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

  it('rules 1-4: the graph counts side-effect and dynamic imports as edges', () => {
    // A side-effect import reaches a module exactly as well as a named one, so
    // a walker that followed only `from` would let an external turn module pull
    // in `standard-tool-execution` while this suite still passed.
    expect(
      relativeImportsIn(
        [
          "import '../../generation/application/standard-tool-execution';",
          "import { executeTool } from './tool-executor';",
          "const late = await import('../../generation/application/turn-stages');",
          "import type { Thing } from '@mangostudio/shared';",
        ].join('\n')
      )
    ).toEqual([
      '../../generation/application/standard-tool-execution',
      './tool-executor',
      '../../generation/application/turn-stages',
    ]);
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
      'toolchain',
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
          credentialHomeFingerprint: 'sha256:home-a',
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
