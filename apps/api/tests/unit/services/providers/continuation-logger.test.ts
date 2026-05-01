import { describe, expect, it, spyOn } from 'bun:test';
import {
  logDegrade,
  logValidContinuation,
  logStateUpdate,
  logPersistenceError,
  logStateCleared,
  logContextInfo,
  logProviderDegrade,
} from '../../../../src/services/providers/core/continuation-logger';

function captureWarn(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  spyOn(console, 'warn').mockImplementation((msg: string) => {
    const prefix = '[continuation] ';
    if (msg.startsWith(prefix)) {
      entries.push(JSON.parse(msg.slice(prefix.length)) as Record<string, unknown>);
    }
  });
  return entries;
}

function captureError(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  spyOn(console, 'error').mockImplementation((msg: string) => {
    const prefix = '[continuation] ';
    if (msg.startsWith(prefix)) {
      entries.push(JSON.parse(msg.slice(prefix.length)) as Record<string, unknown>);
    }
  });
  return entries;
}

describe('continuation-logger', () => {
  describe('logDegrade', () => {
    it('emits a structured degrade event with all fields', () => {
      const entries = captureWarn();
      logDegrade({
        chatId: 'chat_001',
        provider: 'openai',
        model: 'gpt-4o',
        from: 'responses',
        to: 'replay',
        reason: 'model changed from "gpt-4" to "gpt-4o"',
        reasonCode: 'model_changed',
        fromProvider: 'openai',
      });
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.event).toBe('degrade');
      expect(entry.chatId).toBe('chat_001');
      expect(entry.provider).toBe('openai');
      expect(entry.model).toBe('gpt-4o');
      expect(entry.from).toBe('responses');
      expect(entry.to).toBe('replay');
      expect(entry.reasonCode).toBe('model_changed');
      expect(entry.fromProvider).toBe('openai');
      expect(entry.ts).toBeGreaterThan(0);
    });

    it('omits fromProvider when absent', () => {
      const entries = captureWarn();
      logDegrade({
        chatId: 'chat_001',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        from: 'interactions',
        to: 'replay',
        reason: 'envelope malformed',
        reasonCode: 'envelope_malformed',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].fromProvider).toBeUndefined();
    });
  });

  describe('logValidContinuation', () => {
    it('emits a valid_continue event', () => {
      const entries = captureWarn();
      logValidContinuation({
        chatId: 'chat_001',
        provider: 'openai',
        model: 'gpt-4o',
        mode: 'responses',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('valid_continue');
      expect(entries[0].mode).toBe('responses');
    });
  });

  describe('logStateUpdate', () => {
    it('emits updated event with cursor presence', () => {
      const entries = captureWarn();
      logStateUpdate({
        chatId: 'chat_001',
        provider: 'openai',
        mode: 'responses',
        hasCursor: true,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('updated');
      expect(entries[0].hasCursor).toBe(true);
    });

    it('emits updated event without cursor', () => {
      const entries = captureWarn();
      logStateUpdate({
        chatId: 'chat_001',
        provider: 'openai-compatible',
        mode: 'stateless-loop',
        hasCursor: false,
      });
      expect(entries[0].hasCursor).toBe(false);
    });
  });

  describe('logPersistenceError', () => {
    it('emits a persist_error via console.error', () => {
      const entries = captureError();
      logPersistenceError({
        chatId: 'chat_001',
        error: 'DB connection failed',
        phase: 'turn_state',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('persist_error');
      expect(entries[0].error).toBe('DB connection failed');
      expect(entries[0].phase).toBe('turn_state');
    });
  });

  describe('logStateCleared', () => {
    it('emits state_cleared without error', () => {
      const entries = captureWarn();
      logStateCleared({ chatId: 'chat_001', reason: 'no_durable_state' });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('state_cleared');
      expect(entries[0].reason).toBe('no_durable_state');
      expect(entries[0].error).toBeUndefined();
    });

    it('includes error when provided', () => {
      const entries = captureWarn();
      logStateCleared({
        chatId: 'chat_001',
        reason: 'loop_exhausted',
        error: 'timeout',
      });
      expect(entries[0].error).toBe('timeout');
    });
  });

  describe('logContextInfo', () => {
    it('emits context event with usage data', () => {
      const entries = captureWarn();
      logContextInfo({
        chatId: 'chat_001',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        inputTokens: 1500,
        limit: 1_048_576,
        ratio: 0.0014,
        mode: 'stateful',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('context');
      expect(entries[0].inputTokens).toBe(1500);
      expect(entries[0].limit).toBe(1_048_576);
      expect(entries[0].ratio).toBe(0.0014);
    });
  });

  describe('logProviderDegrade', () => {
    it('emits provider_degrade with all fields', () => {
      const entries = captureWarn();
      logProviderDegrade({
        provider: 'openai',
        reason: 'cursor_error',
        reasonCode: 'cursor_expired',
        status: 404,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('provider_degrade');
      expect(entries[0].status).toBe(404);
    });

    it('includes toolResults when true', () => {
      const entries = captureWarn();
      logProviderDegrade({
        provider: 'gemini',
        reason: 'cursor_error',
        reasonCode: 'tool_result_cursor_loss',
        toolResults: true,
      });
      expect(entries[0].toolResults).toBe(true);
    });

    it('handles string status', () => {
      const entries = captureWarn();
      logProviderDegrade({
        provider: 'openai',
        reason: 'cursor_error',
        reasonCode: 'cursor_invalid',
        status: 'unknown',
      });
      expect(entries[0].status).toBe('unknown');
    });
  });
});
