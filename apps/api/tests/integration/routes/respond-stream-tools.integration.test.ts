import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { isShellAvailable } from '../../../src/services/tools/builtin/_shell-exec';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  createTestStreamDb,
  mockPassThroughDb,
  mockProviderRegistry,
  mockVerifiedChatOwnership,
  parsePersistedParts,
  parseSseEvents,
  realExecuteTool,
  realGetAllToolDefinitions,
  realGetAllTools,
  realGetSafeEffectiveToolSettings,
  realGetTool,
  restoreAllMocks,
} from './_respond-stream-helpers';

let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('POST /respond/stream — tools', () => {
  it('streams generated image lifecycle events and persists completed artifacts', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    const insertedGeneratedImages: Array<Record<string, unknown>> = [];
    const generateImageRequests: Array<Record<string, unknown>> = [];
    let iteration = 0;
    let capturedToolResults: AgentTurnRequest['toolResults'];
    const generateImage = (request: Record<string, unknown>) => {
      generateImageRequests.push({ ...request });
      return Promise.resolve({ imageUrl: `/images/generated-${generateImageRequests.length}.png` });
    };

    await mockVerifiedChatOwnership();

    await mock.module('../../../src/services/tools', () => ({
      getAllTools: realGetAllTools,
      getAllToolDefinitions: realGetAllToolDefinitions,
      executeTool: realExecuteTool,
      getTool: realGetTool,
      getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
    }));

    await mockProviderRegistry(
      async function* streamImageToolLifecycle(req: AgentTurnRequest) {
        await Promise.resolve();
        iteration += 1;

        if (iteration !== 1) {
          capturedToolResults = req.toolResults;
          yield { type: 'assistant_text_delta', text: 'Images ready' };
          yield { type: 'turn_completed', providerState: null };
          return;
        }

        yield { type: 'tool_call_started', callId: 'image-call-1', name: 'generate_image' };
        yield {
          type: 'tool_call_completed',
          callId: 'image-call-1',
          name: 'generate_image',
          arguments: JSON.stringify({
            prompt: 'Paint mangoes',
            count: 2,
            model: 'test-image-model',
          }),
        };
        yield { type: 'turn_completed', providerState: null };
      },
      { generateImage: generateImage }
    );

    const dbMock = createTestStreamDb({
      userId: TEST_USER.id,
      insertedMessages,
      onInsert: (table, values) => {
        if (table === 'generated_images') insertedGeneratedImages.push({ ...values });
      },
    });

    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Make images', model: 'test-model' })
    );
    const sseEvents = parseSseEvents(await response.text());

    expect(response.status).toBe(200);

    const startedEvents = sseEvents.filter((event) => event.type === 'image_generation_started');
    const completedEvents = sseEvents.filter(
      (event) => event.type === 'image_generation_completed'
    );
    expect(startedEvents).toHaveLength(2);
    expect(completedEvents).toHaveLength(2);
    expect(completedEvents.map((event) => event.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);

    expect(generateImageRequests).toHaveLength(2);
    expect(generateImageRequests[0]).toMatchObject({
      userId: TEST_USER.id,
      prompt: 'Paint mangoes',
      imageSize: '1K',
      modelName: 'test-image-model',
    });

    const streamedToolResult = sseEvents.find(
      (event) => event.type === 'tool_result' && event.name === 'generate_image'
    );
    expect(streamedToolResult?.isError).toBe(false);
    expect(streamedToolResult?.result).toMatchObject({
      count: 2,
      images: [
        { imageUrl: '/images/generated-1.png', modelName: 'test-image-model' },
        { imageUrl: '/images/generated-2.png', modelName: 'test-image-model' },
      ],
    });

    expect(capturedToolResults).toHaveLength(1);
    const modelFeedback = JSON.parse(capturedToolResults?.[0]?.result ?? '{}') as {
      images: Array<{ imageUrl: string }>;
    };
    expect(modelFeedback.images.map((image) => image.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const toolCallIndex = parts.findIndex(
      (part) => part.type === 'tool_call' && part.name === 'generate_image'
    );
    const imageParts = parts.filter((part) => part.type === 'generated_image');
    expect(imageParts).toHaveLength(2);
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf(imageParts[0])).toBeGreaterThan(toolCallIndex);
    expect(parts.indexOf(imageParts[1])).toBeGreaterThan(parts.indexOf(imageParts[0]));
    expect(imageParts[0]).toMatchObject({
      type: 'generated_image',
      toolCallId: 'image-call-1',
      status: 'completed',
      prompt: 'Paint mangoes',
      imageUrl: '/images/generated-1.png',
      modelName: 'test-image-model',
    });
    expect(imageParts[1]).toMatchObject({
      type: 'generated_image',
      toolCallId: 'image-call-1',
      status: 'completed',
      prompt: 'Paint mangoes',
      imageUrl: '/images/generated-2.png',
      modelName: 'test-image-model',
    });

    expect(insertedGeneratedImages).toHaveLength(2);
    expect(insertedGeneratedImages.map((artifact) => artifact.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);
    expect(insertedGeneratedImages.map((artifact) => artifact.toolCallId)).toEqual([
      'image-call-1',
      'image-call-1',
    ]);
    expect(insertedGeneratedImages[0]).toMatchObject({
      userId: TEST_USER.id,
      chatId: 'test-chat',
      prompt: 'Paint mangoes',
      modelName: 'test-image-model',
      metadataJson: JSON.stringify({ quality: '1K' }),
    });
  });

  it('omits disabled tools from provider requests', async () => {
    let capturedToolDefinitions: AgentTurnRequest['toolDefinitions'];

    await mockVerifiedChatOwnership();

    await mock.module(
      '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
      () => ({
        listSavedToolSettings: () =>
          Promise.resolve(
            new Map([
              ['get_current_datetime', { enabled: false, parameters: {} }],
              ['generate_image', { enabled: false, parameters: {} }],
            ])
          ),
      })
    );

    await mockProviderRegistry(async function* streamToolDefinitions(req: AgentTurnRequest) {
      await Promise.resolve();
      capturedToolDefinitions = req.toolDefinitions;
      yield { type: 'assistant_text_delta', text: 'Hi' };
      yield { type: 'turn_completed', providerState: null };
    });

    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedToolDefinitions?.map((definition) => definition.name)).not.toContain(
      'get_current_datetime'
    );
    expect(capturedToolDefinitions?.map((definition) => definition.name)).not.toContain(
      'generate_image'
    );
  });

  it('passes saved tool parameters into execution context', async () => {
    let iteration = 0;

    await mockVerifiedChatOwnership();

    await mock.module(
      '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
      () => ({
        listSavedToolSettings: () =>
          Promise.resolve(
            new Map([
              [
                'get_current_datetime',
                { enabled: true, parameters: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' } },
              ],
            ])
          ),
      })
    );

    await mockProviderRegistry(async function* streamSavedToolParameters() {
      await Promise.resolve();
      iteration += 1;
      if (iteration !== 1) {
        yield { type: 'assistant_text_delta', text: 'Done' };
        yield { type: 'turn_completed', providerState: null };
        return;
      }

      yield { type: 'tool_call_started', callId: 'time-1', name: 'get_current_datetime' };
      yield {
        type: 'tool_call_completed',
        callId: 'time-1',
        name: 'get_current_datetime',
        arguments: '{}',
      };
      yield { type: 'turn_completed', providerState: null };
    });

    await mock.module('../../../src/services/tools', () => ({
      getAllTools: realGetAllTools,
      getAllToolDefinitions: realGetAllToolDefinitions,
      executeTool: realExecuteTool,
      getTool: realGetTool,
      getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
    }));

    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'test-chat',
        prompt: 'What time is it?',
        model: 'test-model',
      })
    );
    const toolResult = parseSseEvents(await response.text()).find(
      (event) => event.type === 'tool_result'
    );

    expect(response.status).toBe(200);
    expect(toolResult?.result).toMatchObject({ timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  });

  it.skipIf(!isShellAvailable('bash'))(
    'runs shell calls without cwd from the chat workdir',
    async () => {
      const workdir = await mkdtemp(join(tmpdir(), 'mango-stream-workdir-'));
      tempDirs.push(workdir);
      let iteration = 0;
      let capturedToolResults: AgentTurnRequest['toolResults'];
      let capturedSystemPrompt: string | undefined;

      await mockVerifiedChatOwnership(workdir);
      await mock.module(
        '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
        () => ({
          listSavedToolSettings: () =>
            Promise.resolve(new Map([['bash', { enabled: true, parameters: {} }]])),
        })
      );
      await mock.module('../../../src/services/tools', () => ({
        getAllTools: realGetAllTools,
        getAllToolDefinitions: realGetAllToolDefinitions,
        executeTool: realExecuteTool,
        getTool: realGetTool,
        getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
      }));
      await mockProviderRegistry(async function* streamShellWorkdir(req: AgentTurnRequest) {
        await Promise.resolve();
        iteration += 1;
        capturedSystemPrompt ??= req.systemPrompt;
        if (iteration > 1) {
          capturedToolResults = req.toolResults;
          yield { type: 'assistant_text_delta', text: 'Done' };
          yield { type: 'turn_completed', providerState: null };
          return;
        }

        yield { type: 'tool_call_started', callId: 'bash-workdir', name: 'bash' };
        yield {
          type: 'tool_call_completed',
          callId: 'bash-workdir',
          name: 'bash',
          arguments: JSON.stringify({ command: 'pwd' }),
        };
        yield { type: 'turn_completed', providerState: null };
      });
      await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

      const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
      restoreAuth = restore;
      const response = await app.handle(
        buildRespondStreamRequest({
          chatId: 'test-chat',
          prompt: 'Print the current directory',
          model: 'test-model',
        })
      );
      await response.text();

      const shellResult = JSON.parse(capturedToolResults?.[0]?.result ?? '{}') as {
        stdout?: string;
      };
      expect(response.status).toBe(200);
      expect(shellResult.stdout?.trim()).toBe(workdir);
      expect(capturedSystemPrompt).toContain(`Working directory:\n${workdir}`);
    }
  );
});
