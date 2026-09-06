/**
 * Wire-level coverage for the Gemini Interactions turn.
 *
 * Every other Gemini suite injects a hand-written fake client, so none of them
 * can catch a request body or an SSE frame the real SDK would reject. This one
 * drives a real `GoogleGenAI` against a local server: the SDK encodes our
 * params for real, and its own stream parser decodes the canned v2 event
 * frames, so a protocol drift in either direction fails here.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { GoogleGenAI } from '@google/genai';
import type { createGeminiClient } from '../../../src/services/providers/gemini/client';
import { streamGeminiAgentTurn } from '../../../src/services/providers/gemini/interactions-stream';
import type { AgentEvent, AgentTurnRequest } from '../../../src/services/providers/types';
import { collectAgentEvents } from '../../support/providers/agent-event-collector';

const INTERACTIONS_PATH = '/v1beta/interactions';

/** A v2 Interactions SSE body: one text turn plus one complete tool call. */
const V2_EVENT_FRAMES = [
  { event_type: 'interaction.created', interaction: { id: 'int_wire', status: 'in_progress' } },
  { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Looking that up.' } },
  { event_type: 'step.stop', index: 0 },
  {
    event_type: 'step.start',
    index: 1,
    step: { type: 'function_call', id: 'fc_wire', name: 'search', arguments: {} },
  },
  {
    event_type: 'step.delta',
    index: 1,
    delta: { type: 'arguments_delta', arguments: '{"query":' },
  },
  { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '"cats"}' } },
  { event_type: 'step.stop', index: 1 },
  {
    event_type: 'interaction.completed',
    interaction: {
      id: 'int_wire',
      status: 'completed',
      usage: { total_input_tokens: 41, total_cached_tokens: 0 },
    },
  },
];

/** A v2 SSE body whose interaction is abandoned rather than completed. */
const ABANDONED_EVENT_FRAMES = [
  { event_type: 'interaction.created', interaction: { id: 'int_gone', status: 'in_progress' } },
  { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Half an ans' } },
  { event_type: 'interaction.status_update', interaction_id: 'int_gone', status: 'failed' },
];

function sseBody(frames: Array<Record<string, unknown>>): string {
  const events = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return `${events}data: [DONE]\n\n`;
}

/** Records the request body the SDK actually put on the wire. */
class RecordingInteractionsServer {
  requestBodies: Array<Record<string, unknown>> = [];
  private server: ReturnType<typeof Bun.serve> | undefined;
  private cachedClient: ReturnType<typeof createGeminiClient> | undefined;

  constructor(private readonly responseFrames: Array<Record<string, unknown>>) {}

  start(): void {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== INTERACTIONS_PATH) {
          return new Response('not found', { status: 404 });
        }

        this.requestBodies.push((await request.json()) as Record<string, unknown>);
        return new Response(sseBody(this.responseFrames), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
  }

  get client(): ReturnType<typeof createGeminiClient> {
    if (!this.server) throw new Error('Server was not started.');
    this.cachedClient ??= new GoogleGenAI({
      apiKey: 'test-key',
      httpOptions: {
        apiVersion: 'v1beta',
        baseUrl: `http://127.0.0.1:${this.server.port}`,
      },
    });
    return this.cachedClient;
  }

  get lastBody(): Record<string, unknown> {
    const body = this.requestBodies.at(-1);
    if (!body) throw new Error('No request reached the server.');
    return body;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
  }
}

const servers: RecordingInteractionsServer[] = [];

afterEach(async () => {
  const outcomes = await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
  // A server that never closed keeps a listener for the rest of the lane, so
  // the teardown has to report rather than swallow.
  expect(failed.map((outcome) => String(outcome.reason))).toEqual([]);
});

function startServer(
  responseFrames: Array<Record<string, unknown>> = V2_EVENT_FRAMES
): RecordingInteractionsServer {
  const server = new RecordingInteractionsServer(responseFrames);
  server.start();
  servers.push(server);
  return server;
}

function baseRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    userId: 'gemini-wire-user',
    modelName: 'gemini-3-flash-preview',
    history: [],
    prompt: 'Find me cats.',
    systemPrompt: 'Be concise',
    toolDefinitions: [
      {
        name: 'search',
        description: 'Search indexed content',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    generationConfig: { thinkingEnabled: true, reasoningEffort: 'high' },
    ...overrides,
  };
}

describe('Gemini Interactions wire contract', () => {
  it('encodes a replayed turn as v2 steps the SDK accepts', async () => {
    const server = startServer();
    const req = baseRequest({
      history: [
        { id: 'h1', role: 'user', text: 'Any cat facts?' },
        {
          id: 'h2',
          role: 'ai',
          text: 'Checking.',
          parts: [
            { type: 'text', text: 'Checking.' },
            {
              type: 'tool_call',
              toolCallId: 'call_prior',
              name: 'search',
              args: { query: 'cats' },
            },
            {
              type: 'tool_result',
              toolCallId: 'call_prior',
              content: '{"hits":1}',
              isError: false,
            },
          ],
        },
      ],
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, server.client));

    expect(server.lastBody.model).toBe('gemini-3-flash-preview');
    expect(server.lastBody.stream).toBe(true);
    expect(server.lastBody.store).toBe(true);
    expect(server.lastBody.system_instruction).toBe('Be concise');
    // `Tool_2` / `FunctionT` are unchanged across the 2.x bump; this is what
    // holds that claim to the wire rather than to the changelog.
    expect(server.lastBody.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search indexed content',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
    expect(server.lastBody.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Any cat facts?' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Checking.' }] },
      { type: 'function_call', id: 'call_prior', name: 'search', arguments: { query: 'cats' } },
      {
        type: 'function_result',
        call_id: 'call_prior',
        name: '',
        result: { output: '{"hits":1}' },
        is_error: false,
      },
      { type: 'user_input', content: [{ type: 'text', text: 'Find me cats.' }] },
    ]);
  });

  it('encodes structured output as a tagged response_format', async () => {
    const server = startServer();
    const req = baseRequest({
      generationConfig: {
        thinkingEnabled: true,
        reasoningEffort: 'high',
        structuredOutput: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
    });

    await collectAgentEvents(streamGeminiAgentTurn(req, server.client));

    expect(server.lastBody.response_mime_type).toBeUndefined();
    expect(server.lastBody.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object' },
    });
    expect(server.lastBody.generation_config).toEqual({
      thinking_level: 'high',
      thinking_summaries: 'auto',
    });
  });

  it('decodes a v2 SSE body through the SDK stream parser', async () => {
    const server = startServer();

    const events: AgentEvent[] = await collectAgentEvents(
      streamGeminiAgentTurn(baseRequest(), server.client)
    );

    expect(events).toEqual([
      { type: 'assistant_text_delta', text: 'Looking that up.' },
      { type: 'tool_call_started', callId: 'fc_wire', name: 'search' },
      { type: 'tool_call_arguments_delta', callId: 'fc_wire', delta: '{"query":' },
      { type: 'tool_call_arguments_delta', callId: 'fc_wire', delta: '"cats"}' },
      {
        type: 'tool_call_completed',
        callId: 'fc_wire',
        name: 'search',
        arguments: '{"query":"cats"}',
      },
      { type: 'turn_completed', providerState: expect.any(String) },
    ]);
  });

  it('fails the turn when the SDK parser delivers an abandoned status', async () => {
    // The rest of this fix is covered against hand-written fakes, which by
    // construction cannot show that the SDK's own parser hands
    // `interaction.status_update` to the accumulator rather than filtering it.
    const server = startServer(ABANDONED_EVENT_FRAMES);

    const events: AgentEvent[] = await collectAgentEvents(
      streamGeminiAgentTurn(baseRequest(), server.client)
    );

    expect(events).toEqual([
      { type: 'assistant_text_delta', text: 'Half an ans' },
      { type: 'turn_error', error: 'Gemini reported that the interaction failed.' },
    ]);
  });
});
