import { describe, expect, it } from 'bun:test';
import {
  hasRuntimeToken,
  persistRuntimeToken,
  readRuntimeToken,
  removeRuntimeToken,
} from '../../../src/services/runtime-client/runtime-token-secrets';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

describe('runtime token secrets', () => {
  it('round-trips a token through the secret store', async () => {
    const store = new InMemorySecretStore();
    await persistRuntimeToken('lan-box', 'serve-secret', store);

    expect(await readRuntimeToken('lan-box', store)).toBe('serve-secret');
    expect(await hasRuntimeToken('lan-box', store)).toBe(true);
    expect(store.store.get('mangostudio:runtime-token:lan-box')).toBe('serve-secret');
  });

  it('hard-fails when the secret store is unavailable', async () => {
    const store = new InMemorySecretStore();
    store.available = false;

    await expect(persistRuntimeToken('lan-box', 'secret', store)).rejects.toMatchObject({
      name: 'RuntimeRemoteError',
      code: 'RUNTIME_UNAVAILABLE',
    });
    await expect(readRuntimeToken('lan-box', store)).rejects.toMatchObject({
      name: 'RuntimeRemoteError',
      code: 'RUNTIME_UNAVAILABLE',
    });
    expect(await hasRuntimeToken('lan-box', store)).toBe(false);
  });

  it('hard-fails when no token is configured', async () => {
    const store = new InMemorySecretStore();
    await expect(readRuntimeToken('missing', store)).rejects.toMatchObject({
      message: expect.stringContaining('No runtime token'),
    });
    expect(await hasRuntimeToken('missing', store)).toBe(false);
  });

  it('removeRuntimeToken is idempotent', async () => {
    const store = new InMemorySecretStore();
    await persistRuntimeToken('lan-box', 'secret', store);
    await removeRuntimeToken('lan-box', store);
    await removeRuntimeToken('lan-box', store);
    expect(await hasRuntimeToken('lan-box', store)).toBe(false);
  });
});
