import { describe, expect, it } from 'bun:test';
import {
  listMcpSecretEnvNames,
  persistMcpSecretEnv,
  readMcpSecretEnv,
  removeMcpSecretEnv,
} from '../../../../src/services/mcp/stdio-env-secrets';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';

describe('mcp stdio environment secrets', () => {
  it('round-trips a bundle and exposes sorted names only', async () => {
    const store = new InMemorySecretStore();
    const env = { Z_TOKEN: 'z-secret', A_TOKEN: 'a-secret' };

    await persistMcpSecretEnv('server-1', env, store);

    expect(await readMcpSecretEnv('server-1', store)).toEqual(env);
    expect(await listMcpSecretEnvNames('server-1', store)).toEqual(['A_TOKEN', 'Z_TOKEN']);
    expect(store.store.get('mangostudio:mcp-env:server-1')).toBe(JSON.stringify(env));
  });

  it('isolates servers, removes empty bundles, and tolerates malformed data', async () => {
    const store = new InMemorySecretStore();
    await persistMcpSecretEnv('server-1', { TOKEN: 'one' }, store);
    await persistMcpSecretEnv('server-2', { TOKEN: 'two' }, store);
    expect(await readMcpSecretEnv('server-1', store)).toEqual({ TOKEN: 'one' });
    expect(await readMcpSecretEnv('server-2', store)).toEqual({ TOKEN: 'two' });

    await persistMcpSecretEnv('server-1', {}, store);
    expect(await readMcpSecretEnv('server-1', store)).toEqual({});

    store.store.set('mangostudio:mcp-env:server-2', 'not-json');
    expect(await readMcpSecretEnv('server-2', store)).toEqual({});
  });

  it('removal is idempotent and swallows unavailable-store failures', async () => {
    const store = new InMemorySecretStore();
    await persistMcpSecretEnv('server-1', { TOKEN: 'one' }, store);
    await removeMcpSecretEnv('server-1', store);
    await removeMcpSecretEnv('server-1', store);
    expect(store.store.size).toBe(0);

    store.available = false;
    await removeMcpSecretEnv('server-1', store);
  });
});
