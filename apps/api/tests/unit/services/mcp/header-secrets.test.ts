import { describe, expect, it } from 'bun:test';
import {
  listMcpHeaderNames,
  persistMcpHeaders,
  readMcpHeaders,
  removeMcpHeaders,
} from '../../../../src/services/mcp/header-secrets';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';

describe('mcp header secrets', () => {
  it('round-trips a header bundle through the secret store', async () => {
    const store = new InMemorySecretStore();
    const headers = { Authorization: 'Bearer token-123', 'X-Custom': 'value' };

    await persistMcpHeaders('server-1', headers, store);

    expect(await readMcpHeaders('server-1', store)).toEqual(headers);
    expect(await listMcpHeaderNames('server-1', store)).toEqual(['Authorization', 'X-Custom']);
    expect(store.store.get('mangostudio:mcp-headers:server-1')).toBe(JSON.stringify(headers));
  });

  it('keeps bundles isolated per server', async () => {
    const store = new InMemorySecretStore();
    await persistMcpHeaders('server-1', { Authorization: 'a' }, store);
    await persistMcpHeaders('server-2', { 'X-Api-Key': 'b' }, store);

    expect(await listMcpHeaderNames('server-1', store)).toEqual(['Authorization']);
    expect(await listMcpHeaderNames('server-2', store)).toEqual(['X-Api-Key']);
  });

  it('persisting an empty map removes the stored bundle', async () => {
    const store = new InMemorySecretStore();
    await persistMcpHeaders('server-1', { Authorization: 'a' }, store);

    await persistMcpHeaders('server-1', {}, store);

    expect(store.store.size).toBe(0);
    expect(await readMcpHeaders('server-1', store)).toEqual({});
  });

  it('treats missing or malformed bundles as empty', async () => {
    const store = new InMemorySecretStore();
    expect(await readMcpHeaders('missing', store)).toEqual({});

    store.store.set('mangostudio:mcp-headers:server-1', 'not-json');
    expect(await readMcpHeaders('server-1', store)).toEqual({});

    store.store.set('mangostudio:mcp-headers:server-2', JSON.stringify(['array']));
    expect(await readMcpHeaders('server-2', store)).toEqual({});

    store.store.set('mangostudio:mcp-headers:server-3', JSON.stringify({ good: 'yes', bad: 42 }));
    expect(await readMcpHeaders('server-3', store)).toEqual({ good: 'yes' });
  });

  it('removeMcpHeaders is idempotent and swallows store failures', async () => {
    const store = new InMemorySecretStore();
    await persistMcpHeaders('server-1', { Authorization: 'a' }, store);

    await removeMcpHeaders('server-1', store);
    await removeMcpHeaders('server-1', store);
    expect(store.store.size).toBe(0);

    store.available = false;
    await removeMcpHeaders('server-1', store);
  });
});
