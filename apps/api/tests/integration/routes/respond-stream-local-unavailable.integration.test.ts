/**
 * A text turn whose environment cannot be reached answers the way every other
 * route does: the fixed 503 text and `ENVIRONMENT_UNAVAILABLE`, never the connection
 * manager's diagnostic. `POST /respond/stream` resolves the environment inside
 * the stream, so the failure arrives as an `SSEErrorEvent` after the response
 * has started. (`POST /respond` makes one tool-less call and never contacts an
 * environment, so it has no such case.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ERROR_CODES } from '@mangostudio/shared/errors';

import { getDb } from '../../../src/db/database';
import { EnvironmentUnavailableError } from '../../../src/lib/environment-unavailable';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AgentEvent, AIProvider } from '../../../src/services/providers/types';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { parseSseEvents } from './_respond-stream-helpers';

const MODEL_ID = 'local-unavailable-model';
/** Diagnostic text a real connect failure carries; it must never reach a client. */
const LEAKY_DIAGNOSTIC =
  'No mangostudio-runtime binary was found; searched /home/alice/mango/target/debug/mangostudio-runtime. Set MANGOSTUDIO_RUNTIME_BINARY.';

class NoopProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }
  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }
  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }
  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }
  async *generateAgentTurnStream(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: 'turn_completed' };
  }
}

let user: UserFixture;
let chatId: string;
let manager: RuntimeConnectionManager;
let previousProvider: AIProvider | null = null;
let restoreAuth: (() => void) | null = null;

beforeEach(async () => {
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `${user.id}-connector`,
      name: 'Local Unavailable Connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: null,
      updatedAt: Date.now(),
      lastValidatedAt: null,
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId: user.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(new NoopProvider());

  manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: {
      'in-process': () =>
        Promise.reject(new EnvironmentUnavailableError('binary-missing', LEAKY_DIAGNOSTIC)),
    },
  });
  setRuntimeConnectionManagerForTests(manager);
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  if (previousProvider) registerProvider(previousProvider);
  await manager.closeAll();
  setRuntimeConnectionManagerForTests(undefined);
});

function post(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, prompt: 'hello', model: MODEL_ID }),
  });
}

describe('text turn with the environment unavailable', () => {
  it('POST /respond/stream ends with one SSEErrorEvent carrying the fixed text and ENVIRONMENT_UNAVAILABLE', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(user, errorHandler, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(post('/respond/stream'));
    const text = await response.text();
    const errors =
      response.status === 200 ? parseSseEvents(text).filter((e) => e.type === 'error') : [];

    expect(
      response.status === 200 ? errors : [{ httpStatus: response.status, text }],
      `(POST /respond/stream): expected an SSE error event {code:'ENVIRONMENT_UNAVAILABLE'} without the diagnostic | received: ${response.status} ${text}`
    ).toEqual([
      {
        type: 'error',
        error: 'The runtime for this environment is not installed on the hub.',
        code: ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
        done: true,
      },
    ]);
    expect(text, `(POST /respond/stream): the diagnostic leaked | received: ${text}`).not.toContain(
      '/home/alice'
    );
  });
});
