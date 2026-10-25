import type { ListActivityResponse } from '@mangostudio/shared/activity';
import type { AgentProfileListResponse } from '@mangostudio/shared/agents';
import type { ModelCatalogResponse } from '@mangostudio/shared/catalog';
import type { Chat } from '@mangostudio/shared/chat';
import type {
  AgentCliStatusList,
  Environment,
  RuntimeStatusList,
} from '@mangostudio/shared/environments';
import type { ExternalAgentDescriptorListResponse } from '@mangostudio/shared/external-agents';
import type { GithubInboxResponse } from '@mangostudio/shared/github';
import type { LibraryScanResult } from '@mangostudio/shared/library';
import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
import type { Page, Route } from '@playwright/test';

const LOCAL_MACHINE: Environment = {
  id: 'local',
  name: 'Local',
  transportKind: 'stdio',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: true,
  createdAt: null,
  updatedAt: null,
  status: { state: 'connected' },
};

const BACKGROUND_READS: Readonly<Record<string, unknown>> = {
  '/api/settings/models': {
    configured: false,
    status: 'idle',
    allModels: [],
    textModels: [],
    imageModels: [],
    discoveredTextModels: [],
    discoveredImageModels: [],
  } satisfies ModelCatalogResponse,
  '/api/settings/agents': { agents: [] } satisfies AgentProfileListResponse,
  '/api/environments': [LOCAL_MACHINE] satisfies Environment[],
  '/api/external-agents': {
    environmentId: 'local',
    agents: [],
  } satisfies ExternalAgentDescriptorListResponse,
  '/api/environments/runtimes': [] satisfies RuntimeStatusList,
  '/api/environments/agents': [] satisfies AgentCliStatusList,
  '/api/library/resources': { resources: [], unreadableEntries: [] } satisfies LibraryScanResult,
  '/api/activity': { events: [] } satisfies ListActivityResponse,
  '/api/github/inbox': { state: 'ok', cachedAt: 0, items: [] } satisfies GithubInboxResponse,
  '/api/machine/update': {
    installedVia: { manager: 'source', channel: 'stable', executable: '/fixture/mangostudio' },
    channel: 'stable',
    check: null,
    checksEnabled: false,
    canUpgrade: false,
  } satisfies MachineUpdateStatus,
};

/**
 * Give animation-only cases stable background read models without spending the shared HTTP quota.
 * Authentication, app-settings gates, chat mutations and unlisted reads still use the real hub.
 * Example: await installMotionReadModels(page, { emptyChatList: true });
 */
export async function installMotionReadModels(
  page: Page,
  options: { readonly emptyChatList?: boolean } = {}
): Promise<void> {
  await page.route('**/api/**', function motionBackgroundRead(route: Route) {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const path = new URL(request.url()).pathname;
    if (path === '/api/chats' && options.emptyChatList) {
      return route.fulfill({ json: [] satisfies Chat[] });
    }
    if (!Object.hasOwn(BACKGROUND_READS, path)) return route.fallback();
    return route.fulfill({ json: BACKGROUND_READS[path] });
  });
}
