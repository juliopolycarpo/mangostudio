import { describe, expect, test } from 'bun:test';

import { ListActivityResponseSchema } from '@mangostudio/shared/activity';
import { AgentProfileListResponseSchema } from '@mangostudio/shared/agents';
import { ModelCatalogResponseSchema } from '@mangostudio/shared/catalog';
import { ChatListSchema } from '@mangostudio/shared/chat';
import {
  AgentCliStatusListSchema,
  EnvironmentListSchema,
  RuntimeStatusListSchema,
} from '@mangostudio/shared/environments';
import { ExternalAgentDescriptorListResponseSchema } from '@mangostudio/shared/external-agents';
import { GithubInboxResponseSchema } from '@mangostudio/shared/github';
import { LibraryScanResultSchema } from '@mangostudio/shared/library';
import { MachineUpdateStatusSchema } from '@mangostudio/shared/updates';
import type { Page, Route } from '@playwright/test';
import { Value } from 'typebox/value';

import { installMotionReadModels } from '../../tests/browser-smoke/support/motion-read-models';

class FakeRequest {
  constructor(
    readonly path: string,
    readonly verb: string
  ) {}
  url(): string {
    return `http://localhost:3001${this.path}`;
  }
  method(): string {
    return this.verb;
  }
}

class FakeRoute {
  readonly fulfillments: unknown[] = [];
  fallbacks = 0;
  constructor(readonly input: FakeRequest) {}
  request(): FakeRequest {
    return this.input;
  }
  fulfill(options: { json: unknown }): Promise<void> {
    this.fulfillments.push(options.json);
    return Promise.resolve();
  }
  fallback(): Promise<void> {
    this.fallbacks++;
    return Promise.resolve();
  }
}

class FakePage {
  handler?: (route: Route) => unknown;
  route(_pattern: string, handler: (route: Route) => unknown): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }
  async dispatch(path: string, method = 'GET'): Promise<FakeRoute> {
    if (!this.handler) throw new Error('Expected motion read-model handler to be installed');
    const route = new FakeRoute(new FakeRequest(path, method));
    await this.handler(route as unknown as Route);
    return route;
  }
}

const readModels = [
  ['/api/settings/models', ModelCatalogResponseSchema],
  ['/api/settings/agents', AgentProfileListResponseSchema],
  ['/api/environments', EnvironmentListSchema],
  ['/api/external-agents', ExternalAgentDescriptorListResponseSchema],
  ['/api/environments/runtimes', RuntimeStatusListSchema],
  ['/api/environments/agents', AgentCliStatusListSchema],
  ['/api/library/resources', LibraryScanResultSchema],
  ['/api/activity', ListActivityResponseSchema],
  ['/api/github/inbox', GithubInboxResponseSchema],
  ['/api/machine/update', MachineUpdateStatusSchema],
] as const;

describe('Motion animation background reads', () => {
  for (const [path, schema] of readModels) {
    test(`${path} with query returns its canonical response without reaching the hub`, async () => {
      const page = new FakePage();
      await installMotionReadModels(page as unknown as Page);
      const route = await page.dispatch(`${path}?environmentId=local&limit=5`);
      expect(route.fallbacks).toBe(0);
      expect(route.fulfillments).toHaveLength(1);
      expect(Value.Check(schema, route.fulfillments[0])).toBe(true);
    });
  }

  test.each([
    ['/api/auth/get-session', 'GET'],
    ['/api/settings/app', 'GET'],
    ['/api/tool-identities', 'GET'],
    ['/api/settings/models/refresh', 'GET'],
    ['/api/settings/models', 'POST'],
    ['/api/chats/chat-id', 'PUT'],
    ['/api/chats/chat-id', 'DELETE'],
    ['/api/github/inbox', 'POST'],
  ])('%s %s retains the real hub boundary', async (path, method) => {
    const page = new FakePage();
    await installMotionReadModels(page as unknown as Page, { emptyChatList: true });
    const route = await page.dispatch(path, method);
    expect(route.fallbacks).toBe(1);
    expect(route.fulfillments).toEqual([]);
  });

  test('chat reads stay real by default; empty lists require opting in', async () => {
    const page = new FakePage();
    await installMotionReadModels(page as unknown as Page);
    const real = await page.dispatch('/api/chats');
    expect(real.fallbacks).toBe(1);
    expect(real.fulfillments).toEqual([]);

    await installMotionReadModels(page as unknown as Page, { emptyChatList: true });
    const empty = await page.dispatch('/api/chats?cursor=page');
    expect(empty.fallbacks).toBe(0);
    expect(empty.fulfillments).toEqual([[]]);
    expect(Value.Check(ChatListSchema, empty.fulfillments[0])).toBe(true);
    const create = await page.dispatch('/api/chats', 'POST');
    expect(create.fallbacks).toBe(1);
    expect(create.fulfillments).toEqual([]);
  });
});
