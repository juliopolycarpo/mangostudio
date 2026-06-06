import type { UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../../vite.config';

function getProxyConfig(): NonNullable<NonNullable<UserConfig['server']>['proxy']> {
  if (typeof viteConfig === 'function') {
    throw new Error('Expected vite.config.ts to export an object config.');
  }

  if ('then' in viteConfig) {
    throw new Error('Expected vite.config.ts to export a synchronous config.');
  }

  return viteConfig.server?.proxy ?? {};
}

function getManualChunks(): (id: string) => string | undefined {
  if (typeof viteConfig === 'function' || 'then' in viteConfig) {
    throw new Error('Expected vite.config.ts to export a synchronous object config.');
  }

  const output = viteConfig.build?.rollupOptions?.output;
  if (Array.isArray(output)) throw new Error('Expected a single Rollup output config.');

  const manualChunks = output?.manualChunks;
  if (typeof manualChunks !== 'function') throw new Error('Expected manualChunks function.');
  return manualChunks as (id: string) => string | undefined;
}

describe('vite dev server proxy', () => {
  it('proxies generated image paths to the API server', () => {
    const proxy = getProxyConfig();

    expect(proxy).toHaveProperty('/images');
    expect(proxy['/images']).toEqual(proxy['/uploads']);
  });
});

describe('vite build chunks', () => {
  it('splits markdown parser and Shiki core without grouping lazy language grammars', () => {
    const manualChunks = getManualChunks();

    expect(manualChunks('/repo/node_modules/marked/lib/marked.esm.js')).toBe('markdown-parser');
    expect(manualChunks('/repo/node_modules/@shikijs/core/dist/index.mjs')).toBe('syntax-core');
    expect(manualChunks('/repo/node_modules/@shikijs/themes/dist/one-dark-pro.mjs')).toBe(
      'syntax-themes'
    );
    expect(manualChunks('/repo/node_modules/@shikijs/langs/dist/rust.mjs')).toBeUndefined();
  });
});
