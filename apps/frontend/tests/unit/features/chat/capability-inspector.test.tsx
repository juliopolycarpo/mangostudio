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

void mock.module('@tanstack/react-router', () => ({ ...actualRouter, Link: LinkStub }));

const { CapabilityInspector } =
  await import('../../../../src/features/chat/components/CapabilityInspector');

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
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // The enabled row waits behind the section's fold, one press away.
    expect(screen.queryByText('Image generation')).not.toBeInTheDocument();
    // Built-in tools come first; the skills section folds its one enabled row too.
    await userEvent.click(screen.getAllByRole('button', { name: 'Show 1 enabled' })[0]);
    expect(screen.getByText('Image generation')).toBeInTheDocument();

    // The status line under the composer already says model, agent and context,
    // so the panel does not repeat them as chips.
    expect(screen.queryByText('gpt-test')).not.toBeInTheDocument();
    expect(screen.queryByText('42%')).not.toBeInTheDocument();

    // Disabled builtin renders its typed reason as a translated string.
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('disabled in tool settings')).toBeInTheDocument();
    // The reason is plain words; the agent's settings are offered once, on the
    // section's heading line, beside the section's own settings link.
    expect(screen.getByText('not in the agent tool allowlist').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Agent settings' })).toHaveAttribute(
      'href',
      '/settings/agents'
    );
    expect(screen.getAllByRole('link', { name: 'Agent settings' })).toHaveLength(1);

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
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not load capabilities. Try again.'
      );
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
    expect(await screen.findByText('Bash')).toBeInTheDocument();
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

  describe('the quiet normal state', () => {
    async function openWith(response: ChatCapabilitiesResponse) {
      scenario.respondWithJson('GET', '/api/chats/chat-1/capabilities?model=gpt-test', {
        body: response,
      });
      render(<CapabilityInspector chatId="chat-1" activeModel="gpt-test" />);
      await userEvent.click(screen.getByRole('button', { name: /capabilities/i }));
      await screen.findByText(/Built-in tools/);
    }

    const ALL_ON: ChatCapabilitiesResponse = {
      ...RESPONSE,
      tools: RESPONSE.tools.map((tool) => ({ ...tool, state: 'enabled', reason: undefined })),
      mcpServers: RESPONSE.mcpServers.map((server) => ({
        ...server,
        state: 'enabled',
        reason: undefined,
        health: 'connected',
      })),
      skills: RESPONSE.skills.map((skill) => ({ ...skill, state: 'enabled', reason: undefined })),
    };

    it('collapses a section where everything is on to its count line', async () => {
      await openWith(ALL_ON);

      const builtins = screen.getByRole('button', { name: /Built-in tools/ });
      expect(builtins).toHaveAttribute('aria-expanded', 'false');
      expect(builtins).toHaveTextContent('3/3 enabled');
      expect(screen.queryByText('Image generation')).not.toBeInTheDocument();

      await userEvent.click(builtins);

      expect(builtins).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Image generation')).toBeInTheDocument();
    });

    it('opens by itself the section that holds something not enabled', async () => {
      await openWith(RESPONSE);

      expect(screen.getByRole('button', { name: /Built-in tools/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });

    it('marks only the rows that need explaining, and lists those first', async () => {
      await openWith(RESPONSE);
      await userEvent.click(screen.getAllByRole('button', { name: 'Show 1 enabled' })[0]);

      const enabledRow = screen.getByText('Image generation').closest('div.flex');
      const disabledRow = screen.getByText('Bash').closest('div.flex');
      // A dot is the signal; an enabled row has the space for one and no dot in it.
      expect(enabledRow?.querySelector('[data-tone]')).toBeNull();
      expect(disabledRow?.querySelector('[data-tone="neutral"]')).not.toBeNull();

      const order = screen
        .getAllByText(/Image generation|Bash|Todo/)
        .map((node) => node.textContent);
      expect(order.at(-1)).toContain('Image generation');
    });

    it('lists what needs explaining and folds the enabled rows behind a count', async () => {
      await openWith(RESPONSE);

      expect(screen.getByText('Bash')).toBeInTheDocument();
      expect(screen.getByText('Todo')).toBeInTheDocument();
      expect(screen.queryByText('Image generation')).not.toBeInTheDocument();

      const [fold] = screen.getAllByRole('button', { name: 'Show 1 enabled' });
      expect(fold).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(fold);

      expect(screen.getByRole('button', { name: 'Hide 1 enabled' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expect(screen.getByText('Image generation')).toBeInTheDocument();
    });

    it('does not repeat the model, the agent or the context usage as chips', async () => {
      await openWith(RESPONSE);

      expect(screen.queryByText('gpt-test')).not.toBeInTheDocument();
      expect(screen.queryByText('Default')).not.toBeInTheDocument();
      expect(screen.queryByText('42%')).not.toBeInTheDocument();
    });
  });
});
