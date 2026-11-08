import { describe, expect, it } from 'bun:test';

import OpenAI from 'openai';

import { CHATGPT_RESPONSES_POLICY } from '../../../src/services/providers/chatgpt';
import {
  streamAgentTurnWithResponses,
  streamResponses,
} from '../../../src/services/providers/core/responses-protocol/stream';
import { streamDeepSeekAgentTurn } from '../../../src/services/providers/deepseek/agent-stream';
import { streamDeepSeekText } from '../../../src/services/providers/deepseek/text-stream';
import { streamOAICompatAgentTurn } from '../../../src/services/providers/openai-compatible/chat-completions-stream';
import { streamChatCompletionText } from '../../../src/services/providers/openai/chat-completions';
import {
  streamAgentTurnWithResponsesAPI,
  streamWithResponsesAPI,
} from '../../../src/services/providers/openai/responses-stream';
import type {
  AgentEvent,
  AgentTurnRequest,
  StreamingChunk,
} from '../../../src/services/providers/types';
import { collectAgentEvents } from '../../support/providers/agent-event-collector';

const REQUEST = {
  userId: 'fixture-user',
  modelName: 'gpt-4o',
  prompt: 'Hello',
  history: [],
} satisfies AgentTurnRequest;

function createSseFixture(events: readonly unknown[]) {
  const requests: string[] = [];
  function respondWithSse(request: Request | URL | string): Promise<Response> {
    requests.push(request instanceof Request ? request.url : String(request));
    const body = [
      ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      'data: [DONE]\n\n',
    ];
    return Promise.resolve(
      new Response(body.join(''), { headers: { 'content-type': 'text/event-stream' } })
    );
  }
  return {
    client: new OpenAI({
      apiKey: 'fixture-key',
      baseURL: 'https://provider-fixture.invalid/v1',
      maxRetries: 0,
      fetch: respondWithSse,
    }),
    requests,
  };
}

async function collectText(
  stream: AsyncIterable<StreamingChunk>,
  chunks: StreamingChunk[]
): Promise<void> {
  for await (const chunk of stream) chunks.push(chunk);
}

const RESPONSE_FAILURES = [
  {
    event: {
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'server_error', message: 'Model unavailable' } },
    },
    message: 'server_error: Model unavailable',
  },
  {
    event: { type: 'error', code: 'rate_limit_exceeded', message: 'Try again later' },
    message: 'rate_limit_exceeded: Try again later',
  },
  {
    event: { type: 'response.failed', response: { status: 'failed', error: null } },
    message: 'Responses stream failed.',
  },
];

describe('Responses terminal failure wire events', () => {
  it.each(RESPONSE_FAILURES)(
    'fails OpenAI and ChatGPT streams on $message',
    async ({ event, message }) => {
      const { client, requests } = createSseFixture([
        { type: 'response.output_text.delta', delta: 'Partial' },
        event,
        { type: 'response.output_text.delta', delta: 'Unexpected after failure' },
        { type: 'response.completed', response: { id: 'unexpected_cursor', output: [] } },
      ]);
      const expected: AgentEvent[] = [
        { type: 'assistant_text_delta', text: 'Partial' },
        { type: 'turn_error', error: message },
      ];
      const req = {
        ...REQUEST,
        providerState: JSON.stringify({ provider: 'openai', responseId: 'prev_fixture' }),
      };
      expect(await collectAgentEvents(streamAgentTurnWithResponsesAPI(client, req))).toEqual(
        expected
      );
      expect(
        await collectAgentEvents(
          streamAgentTurnWithResponses(client, REQUEST, CHATGPT_RESPONSES_POLICY)
        )
      ).toEqual(expected);

      for (const stream of [
        streamWithResponsesAPI(client, REQUEST),
        streamResponses(client, REQUEST, CHATGPT_RESPONSES_POLICY),
      ]) {
        const chunks: StreamingChunk[] = [];
        await expect(collectText(stream, chunks)).rejects.toThrow(message);
        expect(chunks).toEqual([{ type: 'text', text: 'Partial', done: false }]);
      }
      expect(requests).toHaveLength(4);
    }
  );
});

describe('Chat Completions terminal failure wire events', () => {
  it.each(['insufficient_system_resource', 'aborted'])(
    'fails on %s without finalizing pending tools',
    async (reason) => {
      const { client } = createSseFixture([
        { choices: [{ delta: { content: 'Partial' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search', arguments: '{"query":"x"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: reason }] },
        { choices: [{ delta: { content: 'Unexpected after failure' }, finish_reason: 'stop' }] },
      ]);
      const req = { ...REQUEST, modelName: 'deepseek-v4-flash' };
      const message = `Chat Completions stream failed: ${reason}`;
      for (const stream of [
        streamDeepSeekAgentTurn(client, req),
        streamOAICompatAgentTurn(client, req),
      ]) {
        expect(await collectAgentEvents(stream)).toEqual([
          { type: 'assistant_text_delta', text: 'Partial' },
          { type: 'tool_call_started', callId: 'call_1', name: 'search' },
          { type: 'tool_call_arguments_delta', callId: 'call_1', delta: '{"query":"x"}' },
          { type: 'turn_error', error: message },
        ]);
      }

      const deepSeek: StreamingChunk[] = [];
      await collectText(streamDeepSeekText(client, req), deepSeek);
      expect(deepSeek).toEqual([
        { type: 'text', text: 'Partial', done: false },
        { type: 'error', content: message, done: true },
      ]);
      const compatible: StreamingChunk[] = [];
      await expect(collectText(streamChatCompletionText(client, req), compatible)).rejects.toThrow(
        message
      );
      expect(compatible).toEqual([{ type: 'text', text: 'Partial', done: false }]);
    }
  );
});
