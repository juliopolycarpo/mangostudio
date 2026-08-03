import { describe, expect, it } from 'bun:test';
import {
  CONSENT_DENIED_KIND,
  connectInProcessRuntime,
  RuntimeConsentDeniedError,
  RuntimeHost,
  type RuntimeMethodHandler,
  RuntimeServiceError,
} from '@mangostudio/runtime';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const manifest: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

describe('RuntimeClient', () => {
  it('translates an API abort into protocol cancellation without serializing the signal', async () => {
    let receivedParams: unknown;
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'snapshot.hash',
        (params, { signal }) => {
          receivedParams = params;
          return new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled by API test', 'AbortError')),
              { once: true }
            );
          });
        },
      ],
    ]);
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);
    const controller = new AbortController();

    try {
      const request = client.snapshot.hash(
        { path: '/workspace/file.txt' },
        { signal: controller.signal }
      );
      controller.abort();

      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(receivedParams).toEqual({ path: '/workspace/file.txt' });
      expect(receivedParams).not.toHaveProperty('signal');
    } finally {
      connection.close();
    }
  });

  it('translates RUNTIME_DENIED into a typed consent refusal', async () => {
    const handlers = new Map<string, RuntimeMethodHandler>([
      [
        'shell.run',
        () =>
          Promise.reject(
            new RuntimeServiceError(CONSENT_DENIED_KIND, 'shell is refused', {
              method: 'shell.run',
              missing: ['shell'],
              slot: 'host',
              capability: 'shell',
            })
          ),
      ],
    ]);
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      validateFrames: true,
    });
    const client = new RuntimeClient(connection.client);

    try {
      await expect(
        client.shell.run({
          command: 'true',
          kind: 'bash',
          timeoutMs: 1_000,
          maxOutputBytes: 1024,
        })
      ).rejects.toBeInstanceOf(RuntimeConsentDeniedError);
    } finally {
      connection.close();
    }
  });
});
