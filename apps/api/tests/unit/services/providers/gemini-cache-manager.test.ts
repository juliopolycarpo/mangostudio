import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { GeminiCacheManager } from '../../../../src/services/providers/gemini-cache-manager';
import type { ToolDefinition } from '../../../../src/services/providers/types';

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'get_current_datetime',
    description: 'Returns the current date and time.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

function createMockClient(cacheName = 'cachedContents/abc123') {
  return {
    caches: {
      create: mock(() => Promise.resolve({ name: cacheName })),
    },
  } as any;
}

describe('GeminiCacheManager', () => {
  let manager: GeminiCacheManager;

  beforeEach(() => {
    manager = new GeminiCacheManager();
  });

  it('creates a new cache on first call', async () => {
    const client = createMockClient();
    const name = await manager.getOrCreateCache({
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'You are a helpful assistant.',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
    });

    expect(name).toBe('cachedContents/abc123');
    expect(client.caches.create).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(1);
  });

  it('returns cached entry on subsequent calls with same inputs', async () => {
    const client = createMockClient();
    const opts = {
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'You are a helpful assistant.',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
    };

    await manager.getOrCreateCache(opts);
    const name2 = await manager.getOrCreateCache(opts);

    expect(name2).toBe('cachedContents/abc123');
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('creates a new cache when system prompt changes', async () => {
    const client = createMockClient();
    await manager.getOrCreateCache({
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'Prompt A',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
    });

    await manager.getOrCreateCache({
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'Prompt B',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
    });

    expect(client.caches.create).toHaveBeenCalledTimes(2);
    expect(manager.size).toBe(2);
  });

  it('creates a new cache when model changes', async () => {
    const client = createMockClient();
    const base = { systemPrompt: 'Hello', toolDefinitions: TOOL_DEFS, genaiClient: client };

    await manager.getOrCreateCache({ ...base, modelName: 'gemini-2.0-flash' });
    await manager.getOrCreateCache({ ...base, modelName: 'gemini-2.5-pro' });

    expect(client.caches.create).toHaveBeenCalledTimes(2);
  });

  it('invalidates all caches for a given model', async () => {
    const client = createMockClient();
    await manager.getOrCreateCache({
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'A',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
    });

    manager.invalidate('gemini-2.0-flash');
    expect(manager.size).toBe(0);
  });

  it('cleanup removes expired entries', async () => {
    const client = createMockClient();
    await manager.getOrCreateCache({
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'A',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
      ttlSeconds: 0, // expires immediately
    });

    // Allow the entry to expire
    await new Promise((r) => setTimeout(r, 10));
    manager.cleanup();
    expect(manager.size).toBe(0);
  });

  it('recreates cache after expiration', async () => {
    const client = createMockClient();
    const opts = {
      modelName: 'gemini-2.0-flash',
      systemPrompt: 'A',
      toolDefinitions: TOOL_DEFS,
      genaiClient: client,
      ttlSeconds: 0,
    };

    await manager.getOrCreateCache(opts);
    await new Promise((r) => setTimeout(r, 10));
    await manager.getOrCreateCache(opts);

    expect(client.caches.create).toHaveBeenCalledTimes(2);
  });
});
