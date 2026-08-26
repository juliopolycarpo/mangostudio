/**
 * The hub's compact activity card: rows when there is something to report,
 * `null` the moment there is not — loading is the only state with markup of
 * its own, and only until the query settles.
 */

import { describe, expect, it } from 'bun:test';
import type { ActivityEvent } from '@mangostudio/shared/activity';
import { screen } from '@testing-library/react';
import { ActivityCard } from '../../../../src/features/activity/ActivityCard';
import { flushAsyncRender, render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const ACTIVITY_PATH = '/api/activity?limit=5';

function chatCreated(id: string, title: string, createdAt: number): ActivityEvent {
  return {
    id,
    createdAt,
    chatId: 'chat-1',
    workdir: null,
    environmentId: null,
    targetId: null,
    kind: 'chat_created',
    payload: { title },
  };
}

describe('ActivityCard', () => {
  it('renders the newest events', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', ACTIVITY_PATH, {
        body: { events: [chatCreated('evt-1', 'Refactor the git panel', Date.now())] },
      })
      .install();
    try {
      render(<ActivityCard limit={5} compact />);
      expect(await screen.findByText('Started Refactor the git panel')).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('renders nothing when the feed is empty', async () => {
    const scenario = createFetchScenario();
    scenario.respondWithJson('GET', ACTIVITY_PATH, { body: { events: [] } }).install();
    try {
      render(<ActivityCard limit={5} compact />);
      await flushAsyncRender();
      expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  it('renders nothing when the query fails', async () => {
    const scenario = createFetchScenario();
    // No registered response: the request rejects.
    scenario.install();
    try {
      render(<ActivityCard limit={5} compact />);
      await flushAsyncRender();
      expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  /**
   * The "N new" chip is not driven from here on purpose. Reporting a session
   * makes `useRealtimeInvalidation` open a real socket, and an unanswered one
   * strands an `ErrorEvent` under whichever file the runner reaches next. The
   * two halves are covered where they can be: `countNewSince` in
   * `group-activity.test.ts`, the bookmark itself in
   * `use-activity-bookmark.test.ts`.
   */
  it('shows no count for a signed-out render', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', ACTIVITY_PATH, {
        body: { events: [chatCreated('evt-1', 'Old news', Date.now() - 90_000)] },
      })
      .install();
    try {
      render(<ActivityCard limit={5} compact />);
      expect(await screen.findByText('Started Old news')).toBeInTheDocument();
      expect(screen.queryByText(/\bnew$/)).toBeNull();
    } finally {
      scenario.restore();
    }
  });
});
