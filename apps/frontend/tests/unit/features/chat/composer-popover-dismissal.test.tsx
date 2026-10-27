/**
 * Every popover over the composer closes the same way: a press outside it, or
 * Escape while focus is inside it, with focus handed back to the control that
 * opened it. Two of them used to close only from their own trigger, and two
 * more ignored Escape, so a panel left open sat on the status line and the
 * draft until you found its button again.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';

import type { ModelOption } from '@mangostudio/shared/catalog';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModelSelector } from '../../../../src/components/layout/ModelSelector';
import { RunnerSelector } from '../../../../src/components/layout/RunnerSelector';
import { CapabilityInspector } from '../../../../src/features/chat/components/CapabilityInspector';
import { McpComposerMenu } from '../../../../src/features/chat/components/McpComposerMenu';
import { PermissionSelector } from '../../../../src/features/chat/components/PermissionSelector';
import { EMPTY_MODEL_CATALOG } from '../../../../src/utils/model-utils';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

let scenario: ReturnType<typeof createFetchScenario> | undefined;

afterEach(() => {
  scenario?.restore();
  scenario = undefined;
});

const MODELS: ModelOption[] = [
  {
    modelId: 'gemini-pro',
    displayName: 'Gemini Pro',
    resourceName: 'gemini-pro',
    supportedActions: ['text'],
    provider: 'gemini',
  },
];

interface Case {
  readonly name: string;
  /** Renders the control and returns the button that opens it. */
  readonly mount: () => HTMLElement;
  /** Something only the open panel contains. */
  readonly panel: () => HTMLElement | null;
}

const CASES: readonly Case[] = [
  {
    name: 'the model menu',
    mount: () => {
      render(
        <ModelSelector
          activeModel="gemini-pro"
          activeModels={MODELS}
          isDisabled={false}
          onSelect={() => undefined}
          modelCatalog={EMPTY_MODEL_CATALOG}
        />
      );
      return screen.getByRole('button', { name: /model/i });
    },
    panel: () => screen.queryByText('Gemini Pro', { selector: 'span.truncate' }),
  },
  {
    name: 'the permission menu',
    mount: () => {
      render(
        <PermissionSelector
          configurations={[
            { level: 'default', routing: 'user', supported: true, unattended: false },
            { level: 'read-only', routing: 'user', supported: true, unattended: false },
          ]}
          level="default"
          routing="user"
          targetId="claude"
          onChange={jest.fn()}
        />
      );
      return screen.getByRole('button', { name: /permissions/i });
    },
    panel: () => screen.queryByText('Fine-tune', { exact: false }),
  },
  {
    name: 'the header runner menu',
    mount: () => {
      render(
        <RunnerSelector
          runner={{ kind: 'mangostudio', agentId: 'default' }}
          agents={[]}
          isAgentListLoading={false}
          externalAgents={[]}
          environmentName="Local"
          hasTurns={false}
          onSelectAgent={jest.fn()}
          onSelectExternal={jest.fn()}
          onForkWithRunner={jest.fn()}
          onBrowseSessions={jest.fn()}
        />
      );
      return screen.getByRole('button', { name: /who runs this chat/i });
    },
    panel: () => screen.queryByRole('listbox'),
  },
  {
    name: 'the MCP menu',
    mount: () => {
      scenario = createFetchScenario()
        .respondWithJson('GET', '/api/mcp/servers', { body: { servers: [] } })
        .install();
      render(
        <McpComposerMenu chatId="chat-1" onInsertPrompt={jest.fn()} onAttachments={jest.fn()} />
      );
      return screen.getByRole('button', { name: 'MCP' });
    },
    panel: () => screen.queryByText('MCP prompts and resources'),
  },
  {
    name: 'the capability inspector',
    mount: () => {
      render(<CapabilityInspector chatId={null} />);
      return screen.getByRole('button', { name: /capabilities/i });
    },
    panel: () => screen.queryByText('Open a chat to inspect capabilities.'),
  },
];

describe.each(CASES)('$name', ({ mount, panel }) => {
  it('closes on a press outside it', async () => {
    const user = userEvent.setup();
    const trigger = mount();

    await user.click(trigger);
    expect(panel()).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(panel()).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not close on a press inside it', async () => {
    const user = userEvent.setup();
    const trigger = mount();

    await user.click(trigger);
    const open = panel();
    expect(open).not.toBeNull();
    fireEvent.mouseDown(open as HTMLElement);

    expect(panel()).not.toBeNull();
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    const trigger = mount();

    await user.click(trigger);
    expect(panel()).not.toBeNull();

    await user.keyboard('{Escape}');

    expect(panel()).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('keeps Escape to itself, so a surrounding dialog does not also close', async () => {
    const user = userEvent.setup();
    const reachedDocument = jest.fn();
    document.addEventListener('keydown', reachedDocument);
    const trigger = mount();

    await user.click(trigger);
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', reachedDocument);

    expect(reachedDocument).not.toHaveBeenCalled();
  });

  it('leaves Escape alone while closed', async () => {
    const user = userEvent.setup();
    const reachedDocument = jest.fn();
    document.addEventListener('keydown', reachedDocument);
    const trigger = mount();

    trigger.focus();
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', reachedDocument);

    expect(reachedDocument).toHaveBeenCalledTimes(1);
  });
});

describe('a press outside', () => {
  it('does not pull focus back to the control it closed', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CapabilityInspector chatId={null} />
        <textarea aria-label="Draft" />
      </>
    );

    await user.click(screen.getByRole('button', { name: /capabilities/i }));
    await user.click(screen.getByRole('textbox', { name: 'Draft' }));

    expect(screen.queryByText('Open a chat to inspect capabilities.')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
  });
});
