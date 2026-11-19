import type { ApiKeyPluginApi, ApiKeyPluginRecord } from '../../src/auth';

/**
 * Named fake for the `verifyApiKey` endpoint. Knows the keys it was given and
 * records every call, so a test can assert how many verifications a request cost
 * without minting real Better Auth keys. An unknown key resolves like Better
 * Auth's own answer: `valid: false` with no record.
 *
 * Usage: const api = new FakeApiKeyVerifyApi().register('mango_a', 'key-a', 'user-1');
 */
export class FakeApiKeyVerifyApi implements Pick<ApiKeyPluginApi, 'verifyApiKey'> {
  /** Raw key value of every `verifyApiKey` call, in order. */
  readonly verifiedKeys: string[] = [];
  private readonly records = new Map<string, ApiKeyPluginRecord>();

  register(key: string, id: string, referenceId: string): this {
    this.records.set(key, {
      id,
      name: null,
      start: null,
      referenceId,
      createdAt: new Date(0),
      expiresAt: null,
      lastRequest: null,
      metadata: { scope: 'full' },
    });
    return this;
  }

  verifyApiKey: ApiKeyPluginApi['verifyApiKey'] = ({ body }) => {
    this.verifiedKeys.push(body.key);
    const record = this.records.get(body.key);
    return Promise.resolve(
      record
        ? { valid: true, error: null, key: record }
        : { valid: false, error: { code: 'INVALID_API_KEY' }, key: null }
    );
  };
}
