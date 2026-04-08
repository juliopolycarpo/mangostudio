/**
 * Tests for the get_current_datetime builtin tool and agent event accumulation patterns.
 */

import { describe, expect, it } from 'bun:test';

// Import the builtin so it self-registers
import '../../../src/services/tools/builtin/get-current-datetime';
import { getTool, executeTool } from '../../../src/services/tools/registry';
import type { GetCurrentDatetimeResult } from '../../../src/services/tools/builtin/get-current-datetime';

const ctx = { userId: 'u1', chatId: 'c1' };

describe('get_current_datetime builtin', () => {
  it('is registered in the tool registry', () => {
    const tool = getTool('get_current_datetime');
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe('get_current_datetime');
    expect(tool?.definition.description.length).toBeGreaterThan(0);
  });

  it('returns a valid result for UTC defaults', async () => {
    const result = (await executeTool('get_current_datetime', {}, ctx)) as GetCurrentDatetimeResult;

    expect(result.timezone).toBe('UTC');
    expect(result.locale).toBe('en-US');
    expect(typeof result.isoUtc).toBe('string');
    expect(result.isoUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.unixMs).toBe('number');
    expect(result.unixMs).toBeGreaterThan(0);
    expect(typeof result.localDateTime).toBe('string');
    expect(typeof result.offset).toBe('string');
  });

  it('returns a valid result for America/Sao_Paulo, pt-BR', async () => {
    const result = (await executeTool(
      'get_current_datetime',
      { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
      ctx
    )) as GetCurrentDatetimeResult;

    expect(result.timezone).toBe('America/Sao_Paulo');
    expect(result.locale).toBe('pt-BR');
    expect(result.isoUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws a descriptive error for an invalid timezone', async () => {
    let threw = false;
    try {
      await executeTool('get_current_datetime', { timezone: 'Not/ATimezone' }, ctx);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('Invalid timezone');
    }
    expect(threw).toBe(true);
  });

  it('returns unixMs within the current second', async () => {
    const before = Date.now();
    const result = (await executeTool('get_current_datetime', {}, ctx)) as GetCurrentDatetimeResult;
    const after = Date.now();

    expect(result.unixMs).toBeGreaterThanOrEqual(before);
    expect(result.unixMs).toBeLessThanOrEqual(after + 100); // small tolerance
  });

  it('has a parameters schema with timezone and locale properties', () => {
    const tool = getTool('get_current_datetime');
    if (!tool) throw new Error('expected get_current_datetime to be registered');
    const schema = tool.definition.parameters as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty('timezone');
    expect(schema.properties).toHaveProperty('locale');
  });
});
