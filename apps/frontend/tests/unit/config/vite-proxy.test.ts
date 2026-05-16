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

describe('vite dev server proxy', () => {
  it('proxies generated image paths to the API server', () => {
    const proxy = getProxyConfig();

    expect(proxy).toHaveProperty('/images');
    expect(proxy['/images']).toEqual(proxy['/uploads']);
  });
});
