/**
 * Wire framing shared by the routes that stream a turn: one `data:` frame per
 * event, and the mapping from the turn's internal events to the SSE payloads
 * the frontend's stream reader parses.
 */

import type { SSEErrorEvent } from '@mangostudio/shared/streaming';

import type { StreamEvent } from '../application/stream-text-turn';

export function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function toSsePayload(event: StreamEvent): object {
  switch (event.type) {
    case 'user_message_id':
      return { type: 'user_message_id', messageId: event.messageId, done: false };
    case 'assistant_message_id':
      return { type: 'assistant_message_id', messageId: event.messageId, done: false };
    case 'thinking_start':
      return { type: 'thinking_start', done: false };
    case 'thinking':
      return { type: 'thinking', text: event.text, done: false };
    case 'text':
      return { type: 'text', text: event.text, done: false };
    case 'tool_call_started':
      return { type: 'tool_call_started', callId: event.callId, name: event.name, done: false };
    case 'tool_call_completed':
      return {
        type: 'tool_call_completed',
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
        done: false,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: event.callId,
        name: event.name,
        result: event.result,
        isError: event.isError,
        done: false,
      };
    case 'tool_execution':
      return {
        type: 'tool_execution',
        callId: event.callId,
        name: event.name,
        execution: event.execution,
        done: false,
      };
    case 'subagent_started':
      return {
        type: 'subagent_started',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        task: event.task,
        done: false,
      };
    case 'subagent_text':
      return {
        type: 'subagent_text',
        callId: event.callId,
        agentId: event.agentId,
        text: event.text,
        done: false,
      };
    case 'subagent_tool_call_started':
      return {
        type: 'subagent_tool_call_started',
        callId: event.callId,
        agentId: event.agentId,
        toolCallId: event.toolCallId,
        name: event.name,
        done: false,
      };
    case 'subagent_completed':
      return {
        type: 'subagent_completed',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        summary: event.summary,
        toolCallCount: event.toolCallCount,
        done: false,
      };
    case 'subagent_failed':
      return {
        type: 'subagent_failed',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        error: event.error,
        done: false,
      };
    case 'image_generation_started':
      return {
        type: 'image_generation_started',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        done: false,
      };
    case 'image_generation_completed':
      return {
        type: 'image_generation_completed',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        imageUrl: event.imageUrl,
        modelName: event.modelName,
        generationTime: event.generationTime,
        done: false,
      };
    case 'image_generation_failed':
      return {
        type: 'image_generation_failed',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        error: event.error,
        errorCode: event.errorCode,
        modelName: event.modelName,
        generationTime: event.generationTime,
        done: false,
      };
    case 'question':
      return {
        type: 'question',
        toolCallId: event.part.toolCallId,
        questions: event.part.questions,
        done: false,
      };
    case 'mcp_elicitation':
      return {
        type: 'mcp_elicitation_request',
        elicitationId: event.part.elicitationId,
        toolCallId: event.part.toolCallId,
        serverSlug: event.part.serverSlug,
        message: event.part.message,
        fields: event.part.fields,
        status: event.part.status,
        done: false,
      };
    case 'mcp_elicitation_status':
      return {
        type: 'mcp_elicitation_status',
        elicitationId: event.elicitationId,
        toolCallId: event.toolCallId,
        status: event.status,
        reason: event.reason,
        done: false,
      };
    case 'todo_update':
      return {
        type: 'todo_update',
        toolCallId: event.part.toolCallId,
        todos: event.part.todos,
        done: false,
      };
    case 'mcp_media':
      return {
        type: 'mcp_media',
        toolCallId: event.part.toolCallId,
        serverSlug: event.part.serverSlug,
        toolName: event.part.toolName,
        kind: event.part.kind,
        mimeType: event.part.mimeType,
        url: event.part.url,
        uri: event.part.uri,
        done: false,
      };
    case 'fallback_notice':
      return {
        type: 'fallback_notice',
        from: event.from,
        to: event.to,
        reason: event.reason,
        done: false,
      };
    case 'continuation_transition':
      return {
        type: 'continuation_transition',
        provider: event.provider,
        modelName: event.modelName,
        fromProvider: event.fromProvider,
        fromMode: event.fromMode,
        toMode: event.toMode,
        reasonCode: event.reasonCode,
        detail: event.detail,
        done: false,
      };
    case 'system_event':
      return { type: 'system_event', event: event.event, detail: event.detail, done: false };
    case 'context_info':
      return {
        type: 'context_info',
        estimatedInputTokens: event.estimatedInputTokens,
        contextLimit: event.contextLimit,
        estimatedUsageRatio: event.estimatedUsageRatio,
        mode: event.mode,
        severity: event.severity,
        done: false,
      };
    case 'done':
      return {
        type: 'done',
        done: true,
        messageId: event.messageId,
        generationTime: event.generationTime,
      };
    case 'error': {
      const errorEvent: SSEErrorEvent = {
        type: 'error',
        error: event.error,
        ...(event.code ? { code: event.code } : {}),
        done: true,
      };
      return errorEvent;
    }
  }
}
