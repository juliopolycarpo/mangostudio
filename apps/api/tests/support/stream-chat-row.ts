import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Selectable } from 'kysely';

import type { Database } from '../../src/db/types';

export type StreamChatOverrides = Pick<
  Partial<Selectable<Database['chats']>>,
  'id' | 'title' | 'lastProviderState'
>;

/** Build the chat columns consumed by ownership and activity recording. @example makeStreamChatRow('u1', { title: 'Renamed chat' }); */
export function makeStreamChatRow(
  userId: string,
  overrides: StreamChatOverrides = {}
): Record<string, unknown> {
  return {
    id: 'chat-1',
    title: 'Stream test chat',
    userId,
    runnerKind: 'mangostudio',
    runnerAgentId: 'default',
    runnerTargetId: null,
    workdir: null,
    environmentId: LOCAL_ENVIRONMENT_ID,
    restrictToolsToWorkdir: null,
    lastProviderState: null,
    ...overrides,
  };
}
