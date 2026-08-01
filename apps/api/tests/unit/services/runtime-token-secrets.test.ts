import { describe, expect, it } from 'bun:test';
import {
  hasRuntimeToken,
  persistRuntimeToken,
  readRuntimeToken,
  removeRuntimeToken,
} from '../../../src/services/runtime-client/runtime-token-secrets';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const USER = 'user-a';

describe('runtime token secrets', () => {
  it('round-trips a token through the secret store', async () => {
    const store = new InMemorySecretStore();
    await persistRuntimeToken(USER, 'lan-box', 'serve-secret', store);

    expect(await readRuntimeToken(USER, 'lan-box', store)).toBe('serve-secret');
    expect(await hasRuntimeToken(USER, 'lan-box', store)).toBe(true);
    expect(store.store.get('mangostudio:runtime-token:user-a:lan-box')).toBe('serve-secret');
  });

  it('scopes tokens per user so shared environment ids do not collide', async () => {
    const store = new InMemorySecretStore();
    await persistRuntimeToken('user-a', 'lan-box', 'token-a', store);
    await persistRuntimeToken('user-b', 'lan-box', 'token-b', store);

    expect(await readRuntimeToken('user-a', 'lan-box', store)).toBe('token-a');
    expect(await readRuntimeToken('user-b', 'lan-box', store)).toBe('token-b');
  });

  it('hard-fails when the secret store is unavailable', async () => {
    const store = new InMemorySecretStore();
    store.available = false;

    await expect(persistRuntimeToken(USER, 'lan-box', 'secret', store)).rejects.toMatchObject({
      name: 'RuntimeRemoteError',
      code: 'RUNTIME_UNAVAILABLE',
    });
    await expect(readRuntimeToken(USER, 'lan-box', store)).rejects.toMatchObject({
      name: 'RuntimeRemoteError',
    });
    expect(await hasRuntimeToken(USER, 'lan-box', store)).toBe(false);
  });

  it('hard-fails when no token is configured', async () => {
    const store = new InMemorySecretStore();
    await expect(readRuntimeToken(USER, 'missing', store)).rejects.toMatchObject({
      message: expect.stringContaining('No runtime token'),
    });
    expect(await hasRuntimeToken(USER, 'missing', store)).toBe(false);
  });

  it('removeRuntimeToken is idempotent', async () => {
    const store = new InMemorySecretStore();
    await persistRuntimeToken(USER, 'lan-box', 'secret', store);
    await removeRuntimeToken(USER, 'lan-box', store);
    await removeRuntimeToken(USER, 'lan-box', store);
    expect(await hasRuntimeToken(USER, 'lan-box', store)).toBe(false);
  });
});
