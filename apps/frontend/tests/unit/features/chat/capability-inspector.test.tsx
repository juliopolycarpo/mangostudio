/**
 * Unit tests for the CapabilityInspector popover: opening the panel fetches
 * the server-resolved projection and renders enabled, disabled, and
 * unavailable entries with their translated reasons — the component never
 * derives eligibility on its own.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChatCapabilitiesResponse } from '@mangostudio/shared/capabilities';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useQueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { useUpdateToolSetting } from '../../../../src/features/settings/tools/hooks/use-tool-settings';
import { toolSettingsKeys } from '../../../../src/features/settings/tools/queries';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { LinkStub } from '../../../support/mocks/router';

// `vi.mock(m, async (importOriginal) => ({ ...await importOriginal(), … }))`
// ports as three statements: import the real namespace, register the mock, then
// import the subject. `mock.module` is not hoisted and static imports are.
const actualRouter = await import('@tanstack/react-router');

mock.module('@tanstack/react-router', () => ({ ...actualRouter, Link: LinkStub }));

const { CapabilityInspector } = await import(
  '../../../../src/features/chat/components/CapabilityInspector'
);

const RESPONSE: ChatCapabilitiesResponse = {
  chatId: 'chat-1',
  model: { modelId: 'gpt-test', provider: 'openai' },
  agent: { id: 'default', name: 'Default', kind: 'builtin' },
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
      name: 'todo',
      title: 'Todo',
      source: 'builtin',
      state: 'disabled',
      reason: 'agent-allowlist',
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

function InspectorWithToolSettingMutation() {
  const queryClient = useQueryClient();
  const mutation = useUpdateToolSetting();

  useEffect(() => {
    queryClient.setQueryData(toolSettingsKeys.list(), { tools: [] });
  }, [queryClient]);

  return (
    <>
      <button
        type="button"
        onClick={() => mutation.mutate({ toolName: 'generate_image', body: { enabled: false } })}
      >
        Disable image generation
      </button>
      {mutation.isSuccess && <span>Tool setting saved</span>}
      <CapabilityInspector chatId="chat-1" activeModel="gpt-test" />
    </>
  );
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('CapabilityInspector', () => {
  it('fetches and renders the projection when opened', async () => {
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities?model=gpt-test', {
      body: RESPONSE,
    });

    render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" />);

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
    expect(screen.getByText('not in the agent tool allowlist')).toHaveAttribute(
      'href',
      '/settings/agents'
    );

    // MCP servers show health and their tools; disabled server shows a reason.
    expect(screen.getByText(/GitHub/)).toBeInTheDocument();
    expect(screen.getByText('create_issue')).toBeInTheDocument();
    expect(screen.getByText('server is disabled')).toBeInTheDocument();

    // Shadowed skill copy is explicit rather than silently omitted.
    expect(screen.getByText('shadowed by a higher-precedence source')).toBeInTheDocument();
  });

  it("speaks for the hub's own machine instead of printing its API name", async () => {
    // `environmentName` is the environment's name in the API — for the hub's
    // own machine a fixed English literal. Interpolating it into a translated
    // sentence would leave a pt-BR reader with "recusada por Local".
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities?model=gpt-test', {
      body: {
        ...RESPONSE,
        tools: [
          {
            name: 'write_file',
            title: 'Write file',
            source: 'builtin',
            state: 'unavailable',
            reason: 'runtime-denied',
            category: 'system',
            environmentName: 'Local',
            environmentId: LOCAL_ENVIRONMENT_ID,
          },
          {
            name: 'read_file',
            title: 'Read file',
            source: 'builtin',
            state: 'unavailable',
            reason: 'runtime-denied',
            category: 'system',
            environmentName: 'Devbox',
            environmentId: 'devbox',
          },
          {
            // A remote a user chose to call "Local". Keying off the name
            // rather than the id would silently rename their machine.
            name: 'grep',
            title: 'Grep',
            source: 'builtin',
            state: 'unavailable',
            reason: 'runtime-denied',
            category: 'system',
            environmentName: 'Local',
            environmentId: 'devbox-two',
          },
        ],
      },
    });

    render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" />);
    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    await waitFor(() => {
      expect(screen.getByText('refused by this machine')).toBeInTheDocument();
    });
    // A remote's name is the user's own text and travels through untouched —
    // including a remote whose name happens to be the hub's own literal, which
    // is what proves the substitution keys off the id and not the string.
    expect(screen.getByText('refused by Devbox')).toBeInTheDocument();
    expect(screen.getByText('refused by Local')).toBeInTheDocument();
    expect(screen.getAllByText('refused by this machine')).toHaveLength(1);
  });

  it('asks for a chat before fetching when none is open', async () => {
    render(<CapabilityInspector chatId={null} />);

    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    expect(screen.getByText('Open a chat to inspect capabilities.')).toBeInTheDocument();
    expect(scenario.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a load error without blocking the composer', async () => {
    scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities?model=gpt-test', {
      status: 500,
      body: { error: 'boom', code: 'INTERNAL' },
    });

    render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" />);

    await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load capabilities');
    });
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('refetches a cached projection after a tool setting changes', async () => {
    const disabledResponse: ChatCapabilitiesResponse = {
      ...RESPONSE,
      tools: RESPONSE.tools.map((tool) =>
        tool.name === 'generate_image'
          ? { ...tool, state: 'disabled', reason: 'tool-setting-disabled' }
          : tool
      ),
      counts: { ...RESPONSE.counts, effectiveTools: RESPONSE.counts.effectiveTools - 1 },
      runtimeHash: 'hash-2',
    };
    const capabilitiesPath = '/api/chats/chat-1/capabilities?model=gpt-test';
    scenario.respondWithJson('GET', capabilitiesPath, { body: RESPONSE });
    scenario.respondWithJson('PUT', '/api/settings/tools/generate_image', {
      body: {
        name: 'generate_image',
        title: 'Image generation',
        description: 'Generate images.',
        category: 'image',
        enabled: false,
        canDisable: true,
        parameters: {},
        parameterDescriptors: [],
      },
    });

    render(<InspectorWithToolSettingMutation />);

    const inspectorButton = screen.getByRole('button', { name: /capabilities/i });
    await userEvent.click(inspectorButton);
    expect(await screen.findByText('Image generation')).toBeInTheDocument();
    await userEvent.click(inspectorButton);

    scenario.respondWithJson('GET', capabilitiesPath, { body: disabledResponse });
    await userEvent.click(screen.getByRole('button', { name: 'Disable image generation' }));
    expect(await screen.findByText('Tool setting saved')).toBeInTheDocument();

    await userEvent.click(inspectorButton);
    await waitFor(() => {
      expect(screen.getAllByText('disabled in tool settings')).toHaveLength(2);
    });

    const capabilityRequests = scenario.fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      const url = input instanceof Request ? input.url : String(input);
      return new URL(url, 'http://localhost').pathname === '/api/chats/chat-1/capabilities';
    });
    expect(capabilityRequests).toHaveLength(2);
  });
});
