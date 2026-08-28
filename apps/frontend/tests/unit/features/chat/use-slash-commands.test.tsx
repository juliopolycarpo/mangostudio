/**
 * Unit tests for the skills source of the composer's `/` palette.
 *
 * The palette must offer exactly what the next turn will advertise. Only the
 * server-resolved capability projection knows whether the chat's tool profile
 * admits the `skill` tool at all, so the hook narrows the user-scoped skill list
 * with it — and, because a projection that has not answered is not a projection
 * that said no, fails open until it does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChatCapabilitiesResponse } from '@mangostudio/shared/capabilities';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { SkillListResponse } from '@mangostudio/shared/skills';
import { waitFor } from '@testing-library/react';
import { useSlashCommands } from '../../../../src/features/chat/hooks/use-slash-commands';
import { renderHook } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const RUNNER: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: 'default' };

const SKILLS: SkillListResponse = {
  skills: [
    {
      key: 'mango:dataviz',
      slug: 'dataviz',
      name: 'dataviz',
      description: 'Draws charts',
      source: 'mango',
      path: '/skills/dataviz',
      valid: true,
      enabled: true,
      shadowed: false,
    },
  ],
  sources: {
    agents: { enabled: false, path: '/agents', exists: false },
    claude: { enabled: false, path: '/claude', exists: false },
  },
};

function capabilities(state: 'enabled' | 'unavailable'): ChatCapabilitiesResponse {
  return {
    chatId: 'chat-1',
    model: { modelId: 'gpt-test' },
    agent: { id: 'default', name: 'Default', kind: 'builtin' },
    tools: [],
    mcpServers: [],
    skills: [
      {
        key: 'mango:dataviz',
        slug: 'dataviz',
        name: 'dataviz',
        source: 'mango',
        state,
        ...(state === 'unavailable' ? { reason: 'skill-tool-disabled' as const } : {}),
      },
    ],
    counts: { effectiveTools: 0, effectiveSkills: state === 'enabled' ? 1 : 0 },
    contextInfo: null,
    runtimeHash: 'hash-1',
  };
}

const scenario = createFetchScenario();

function renderPalette(chatId: string | null) {
  return renderHook(() =>
    useSlashCommands({ chatId, runner: RUNNER, environmentId: null, active: true })
  );
}

beforeEach(() => {
  scenario.install();
  scenario.respondWithJson('GET', '/api/skills', { body: SKILLS });
});

afterEach(() => {
  scenario.restore();
});

describe('useSlashCommands — skills', () => {
  it('offers a skill the chat will advertise', async () => {
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities', {
      body: capabilities('enabled'),
    });

    const { result } = renderPalette('chat-1');

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['dataviz']);
    });
  });

  /**
   * `appendSkillsPromptSection` returns the prompt untouched when the profile
   * withholds the `skill` tool, so the turn carries no `<available-skills>`
   * block. A `/dataviz` completed here would reach the model as literal prose.
   */
  it('withholds a skill whose chat cannot call the skill tool', async () => {
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities', {
      body: capabilities('unavailable'),
    });

    const { result } = renderPalette('chat-1');

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(result.current.entries).toEqual([]);
    });
  });

  /**
   * The home screen has no chat to ask about, and an inspector endpoint that is
   * slow or failing is not an answer either. Both fail open: the user-scoped
   * filter still applies, and the first turn decides.
   */
  it('offers what the user has installed when there is no chat to ask about', async () => {
    const { result } = renderPalette(null);

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['dataviz']);
    });
  });

  it('keeps offering skills when the projection fails', async () => {
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom' } },
    });

    const { result } = renderPalette('chat-1');

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['dataviz']);
    });
  });

  /**
   * Regression for a race between the two sources: `/api/skills` can answer
   * before `/api/chats/:id/capabilities` does, and a palette that fell back to
   * unfiltered for that gap would offer `/dataviz` a beat before the profile
   * check has actually run — the same beat `appendSkillsPromptSection` reads to
   * decide whether the turn gets a prompt section for it at all.
   */
  it('withholds skills while the capability projection is still in flight', async () => {
    const respondToApp = scenario.fetchMock.getMockImplementation();
    if (!respondToApp) throw new Error('fetch scenario has no implementation to wrap');

    let releaseCapabilities: (() => void) | undefined;
    const capabilitiesGate = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });

    scenario.fetchMock.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('/capabilities')) await capabilitiesGate;
      return respondToApp(input, init);
    });
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities', {
      body: capabilities('enabled'),
    });

    const { result } = renderPalette('chat-1');

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });
    expect(result.current.entries).toEqual([]);

    releaseCapabilities?.();

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['dataviz']);
    });
  });
});
