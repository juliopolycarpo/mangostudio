/**
 * Unit tests for the CapabilityInspector popover: opening the panel fetches
 * the server-resolved projection and renders enabled, disabled, and
 * unavailable entries with their translated reasons — the component never
 * derives eligibility on its own.
 */

import type { ChatCapabilitiesResponse } from '@mangostudio/shared/capabilities';
import type * as TanstackRouter from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityInspector } from '../../../../src/features/chat/components/CapabilityInspector';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

const RESPONSE: ChatCapabilitiesResponse = {
  chatId: 'chat-1',
  model: { modelId: 'gpt-test', provider: 'openai' },
  agent: { id: 'chat', name: 'Chat', kind: 'builtin', mode: 'chat' },
  tools: [
    {
      name: 'generate_image',
      title: 'Image generation',
      source: 'builtin',
      state: 'enabled',
      category: 'image',
    },
    {
      name: 'bash',
      title: 'Bash',
      source: 'builtin',
      state: 'disabled',
      reason: 'tool-setting-disabled',
      category: 'system',
    },
    {
      name: 'mcp__github__create_issue',
      title: 'create_issue',
      source: 'mcp',
      state: 'enabled',
      serverSlug: 'github',
      serverName: 'GitHub',
    },
  ],
  mcpServers: [
    {
      slug: 'github',
      name: 'GitHub',
      state: 'enabled',
      health: 'connected',
      effectiveToolCount: 1,
    },
    {
      slug: 'jira',
      name: 'Jira',
      state: 'disabled',
      reason: 'server-disabled',
      health: 'disabled',
      effectiveToolCount: 0,
    },
  ],
  skills: [
    {
      key: 'mango:changelog',
      slug: 'changelog',
      name: 'changelog',
      source: 'mango',
      state: 'enabled',
    },
    {
      key: 'claude:changelog',
      slug: 'changelog',
      name: 'changelog',
      source: 'claude',
      state: 'unavailable',
      reason: 'skill-shadowed',
    },
  ],
  counts: { effectiveTools: 2, effectiveSkills: 1 },
  contextInfo: {
    estimatedInputTokens: 4200,
    contextLimit: 10000,
    estimatedUsageRatio: 0.42,
    mode: 'stateful',
    severity: 'normal',
  },
  runtimeHash: 'hash-1',
};

const scenario = createFetchScenario();

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('CapabilityInspector', () => {
  it('fetches and renders the projection when opened', async () => {
    scenario.respondWithJson(
      'GET',
      '/api/chats/chat-1/capabilities?model=gpt-test&agentMode=chat',
      { body: RESPONSE }
    );

    render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" agentMode="chat" />);

    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    await waitFor(() => {
      expect(screen.getByText('Image generation')).toBeInTheDocument();
    });

    // Model/agent summary and context usage come straight from the response.
    expect(screen.getByText('gpt-test')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();

    // Disabled builtin renders its typed reason as a translated string.
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('disabled in tool settings')).toBeInTheDocument();

    // MCP servers show health and their tools; disabled server shows a reason.
    expect(screen.getByText(/GitHub/)).toBeInTheDocument();
    expect(screen.getByText('create_issue')).toBeInTheDocument();
    expect(screen.getByText('server is disabled')).toBeInTheDocument();

    // Shadowed skill copy is explicit rather than silently omitted.
    expect(screen.getByText('shadowed by a higher-precedence source')).toBeInTheDocument();
  });

  it('asks for a chat before fetching when none is open', async () => {
    render(<CapabilityInspector chatId={null} />);

    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    expect(screen.getByText('Open a chat to inspect capabilities.')).toBeInTheDocument();
    expect(scenario.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a load error without blocking the composer', async () => {
    scenario.respondWithJson(
      'GET',
      '/api/chats/chat-1/capabilities?model=gpt-test&agentMode=chat',
      { status: 500, body: { error: 'boom', code: 'INTERNAL' } }
    );

    render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" agentMode="chat" />);

    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
