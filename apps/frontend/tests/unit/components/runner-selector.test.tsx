/**
 * The selector against fixture descriptors, one per availability state.
 *
 * Eight states are not decoration: each is a different thing the user has to do
 * — install it, sign in, update the runtime, ask the machine's owner — and
 * collapsing them into "unavailable" leaves someone staring at a disabled row
 * with nothing to try. So each is asserted for both disabled-ness and reason.
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type {
  ExternalAgentDescriptor,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunnerSelector } from '../../../src/components/layout/RunnerSelector';
import { render } from '../../support/harness/render';

const AGENTS: AgentProfile[] = [
  { id: 'default', name: 'Default', role: 'primary' } as AgentProfile,
  { id: 'explore', name: 'Explore', role: 'primary' } as AgentProfile,
  { id: 'user:helper', name: 'Sub only', role: 'subagent' } as AgentProfile,
];

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...overrides,
  };
}

function renderSelector(overrides: Partial<React.ComponentProps<typeof RunnerSelector>> = {}) {
  const props = {
    runner: { kind: 'mangostudio', agentId: 'default' } as const,
    agents: AGENTS,
    isAgentListLoading: false,
    externalAgents: [descriptor()],
    environmentName: 'this laptop',
    hasTurns: false,
    onSelectAgent: vi.fn(),
    onSelectExternal: vi.fn(),
    onForkWithRunner: vi.fn(),
    ...overrides,
  };
  const result = render(<RunnerSelector {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /who runs this chat/i }));
  return { ...result, props };
}

function codexOption(): HTMLElement {
  return screen.getByRole('option', { name: /Codex CLI/ });
}

describe('runner selector groups', () => {
  it('offers only primary and both-role agents', () => {
    renderSelector();
    const list = screen.getByRole('listbox');
    expect(within(list).getByRole('option', { name: /Default/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Explore/ })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /Sub only/ })).toBeNull();
  });

  it('says so when a machine reports no external agents at all', () => {
    renderSelector({ externalAgents: [] });
    expect(screen.getByText(/No external agents found/i)).toBeInTheDocument();
  });
});

describe('external availability states', () => {
  it('lets a signed-in agent be selected and reports the account', () => {
    const { props } = renderSelector({
      externalAgents: [descriptor({ account: { label: 'ada@example.test' } })],
    });
    expect(codexOption()).toBeEnabled();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    fireEvent.click(codexOption());
    expect(props.onSelectExternal).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown sign-in state selectable, with a note', () => {
    // Claude may keep credentials in an OS keychain, so a missing credential
    // file is not a signed-out verdict. Disabling here would make an installed,
    // signed-in agent unusable.
    renderSelector({ externalAgents: [descriptor({ authState: 'unknown' })] });
    expect(codexOption()).toBeEnabled();
    expect(screen.getByText(/sign-in state unknown/i)).toBeInTheDocument();
  });

  it('disables a signed-out agent and shows the vendor login command', () => {
    renderSelector({
      externalAgents: [descriptor({ authState: 'signed-out', loginCommand: 'codex login' })],
    });
    expect(codexOption()).toBeDisabled();
    expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy login command/i })).toBeInTheDocument();
  });

  it('names the environment when the agent is not installed there', () => {
    renderSelector({ externalAgents: [descriptor({ installed: false })] });
    expect(codexOption()).toBeDisabled();
    expect(screen.getByText(/Not installed in this laptop/)).toBeInTheDocument();
  });

  it.each([
    ['runtime-unsupported', /cannot host it/i],
    ['runtime-denied', /has not allowed external agents/i],
    ['isolation-unproven', /keeps credentials separate/i],
    ['environment-unreachable', /Could not reach this machine/i],
  ] as const)('disables %s with its own reason', (reason, copy) => {
    renderSelector({
      externalAgents: [descriptor({ unavailableReason: reason as ExternalAgentUnavailableReason })],
    });
    expect(codexOption()).toBeDisabled();
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('never renders an executable path', () => {
    const { container } = renderSelector();
    expect(container.textContent ?? '').not.toMatch(/\/usr\/|\.exe|\/bin\//);
  });
});

describe('D14 — one runner kind per chat', () => {
  it('offers a fork rather than a switch once the chat has turns', () => {
    const { props } = renderSelector({ hasTurns: true });
    expect(screen.getAllByText(/Continue in a new chat/i).length).toBeGreaterThan(0);

    fireEvent.click(codexOption());
    expect(props.onForkWithRunner).toHaveBeenCalledWith({ kind: 'external', targetId: 'codex' });
    expect(props.onSelectExternal).not.toHaveBeenCalled();
  });

  it('switches in place while the chat is still empty', () => {
    const { props } = renderSelector({ hasTurns: false });
    expect(screen.queryByText(/Continue in a new chat/i)).toBeNull();
    fireEvent.click(codexOption());
    expect(props.onSelectExternal).toHaveBeenCalledTimes(1);
    expect(props.onForkWithRunner).not.toHaveBeenCalled();
  });

  it('forks back to MangoStudio from an external chat with turns', () => {
    const { props } = renderSelector({
      runner: { kind: 'external', targetId: 'codex' },
      hasTurns: true,
    });
    fireEvent.click(screen.getByRole('option', { name: /Explore/ }));
    expect(props.onForkWithRunner).toHaveBeenCalledWith({
      kind: 'mangostudio',
      agentId: 'explore',
    });
    expect(props.onSelectAgent).not.toHaveBeenCalled();
  });
});
