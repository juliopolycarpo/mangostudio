/**
 * Manages Gemini explicit CachedContent lifecycle.
 * Caches are keyed by model + system prompt hash + toolset hash.
 * A valid cache avoids re-sending system instructions and tool definitions on every request.
 */

import type { GoogleGenAI } from '@google/genai';
import type { ToolDefinition } from './types';
import { computeHash, computeToolsetHash } from '../../utils/hash';

export interface GeminiCacheEntry {
  cacheName: string;
  toolsetHash: string;
  systemPromptHash: string;
  modelName: string;
  expiresAt: number;
  createdAt: number;
}

export interface GetOrCreateCacheOpts {
  modelName: string;
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  genaiClient: GoogleGenAI;
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 3600;

export class GeminiCacheManager {
  private cacheMap = new Map<string, GeminiCacheEntry>();

  /** Returns a valid cache name or creates a new one. */
  async getOrCreateCache(opts: GetOrCreateCacheOpts): Promise<string> {
    const key = this.computeCacheKey(opts);
    const existing = this.cacheMap.get(key);

    if (existing && existing.expiresAt > Date.now()) {
      return existing.cacheName;
    }

    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const toolsetHash = computeToolsetHash(opts.toolDefinitions);

    const toolDeclarations = opts.toolDefinitions.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }));

    const cache = await opts.genaiClient.caches.create({
      model: opts.modelName,
      config: {
        systemInstruction: opts.systemPrompt,
        tools:
          toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined,
        ttl: `${ttl}s`,
      },
    });

    if (!cache.name) {
      throw new Error('Gemini CachedContent creation returned no name');
    }

    const entry: GeminiCacheEntry = {
      cacheName: cache.name,
      toolsetHash,
      systemPromptHash: computeHash(opts.systemPrompt),
      modelName: opts.modelName,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
    };

    this.cacheMap.set(key, entry);
    return cache.name;
  }

  /** Invalidates all caches for a given model. */
  invalidate(modelName: string): void {
    for (const [key, entry] of this.cacheMap) {
      if (entry.modelName === modelName) {
        this.cacheMap.delete(key);
      }
    }
  }

  /** Removes expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cacheMap) {
      if (entry.expiresAt <= now) {
        this.cacheMap.delete(key);
      }
    }
  }

  /** Returns the number of active cache entries (for testing). */
  get size(): number {
    return this.cacheMap.size;
  }

  private computeCacheKey(
    opts: Pick<GetOrCreateCacheOpts, 'modelName' | 'systemPrompt' | 'toolDefinitions'>
  ): string {
    return `${opts.modelName}:${computeHash(opts.systemPrompt)}:${computeToolsetHash(opts.toolDefinitions)}`;
  }
}

/** Singleton instance for the application. */
export const geminiCacheManager = new GeminiCacheManager();
