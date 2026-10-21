/**
 * The selector against fixture descriptors, one per availability state.
 *
 * Eight states are not decoration: each is a different thing the user has to do
 * — install it, sign in, update the runtime, ask the machine's owner — and
 * collapsing them into "unavailable" leaves someone staring at a disabled row
 * with nothing to try. So each is asserted for both disabled-ness and reason.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import { routerWithLinkStub } from '../../support/mocks/router';

// The remedy for a missing or outdated agent is a link into the surface that
// owns the install recipes, so this file now renders a router `Link`.
mock.module('@tanstack/react-router', await routerWithLinkStub());

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { EnvironmentTransportKind } from '@mangostudio/shared/environments';
import type {
  ExternalAgentDescriptor,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { fireEvent, screen, within } from '@testing-library/react';
import { RunnerSelector } from '../../../src/components/layout/RunnerSelector';
import { render } from '../../support/harness/render';

/** Only the three fields the selector reads; the rest of the profile is noise here. */
function agent(id: string, name: string, role: AgentProfile['role']): AgentProfile {
  return { id, name, role } as unknown as AgentProfile;
}

const AGENTS: AgentProfile[] = [
  agent('default', 'Default', 'primary'),
  agent('explore', 'Explore', 'primary'),
  agent('user:helper', 'Sub only', 'subagent'),
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
    onSelectAgent: jest.fn(),
    onSelectExternal: jest.fn(),
    onForkWithRunner: jest.fn(),
    onBrowseSessions: jest.fn(),
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
  // The name says which agents exist; the line under it says why this one is out
  // of reach. Fading the row to 50% would put the name under the text floor.
  it('does not fade the name of a runner that cannot run here', () => {
    renderSelector({ externalAgents: [descriptor({ installed: false })] });

    expect(codexOption()).toBeDisabled();
    expect(codexOption().className).not.toContain('opacity');
    expect(codexOption().className).toContain('disabled:text-fg-muted');
  });

  it('explains undetermined discovery and still selects the installed target without a version', () => {
    const { props } = renderSelector({
      externalAgents: [descriptor({ discoveryState: 'undetermined' })],
    });
    expect(codexOption()).toBeEnabled();
    expect(
      screen.getByText(
        'The probe could not confirm this agent or its version. You can still try a turn.'
      )
    ).toBeInTheDocument();
    fireEvent.click(codexOption());
    expect(props.onSelectExternal).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryState: 'undetermined' })
    );
  });

  it('announces uncertain discovery in the active runner pill instead of promising availability', () => {
    renderSelector({
      runner: { kind: 'external', targetId: 'codex' },
      externalAgents: [descriptor({ discoveryState: 'undetermined' })],
    });
    expect(screen.getByText('availability undetermined')).toBeInTheDocument();
  });

  it('keeps an explicit refusal authoritative over undetermined discovery', () => {
    for (const refusal of [
      { unavailableReason: 'runtime-denied' },
      { installed: false },
      { authState: 'signed-out' },
    ] as const) {
      const view = renderSelector({
        externalAgents: [descriptor({ discoveryState: 'undetermined', ...refusal })],
      });
      expect(codexOption()).toBeDisabled();
      expect(screen.queryByText(/You can still try a turn/)).toBeNull();
      view.unmount();
    }
  });

  it('lets a signed-in agent be selected and reports the account', () => {
    const { props } = renderSelector({
      externalAgents: [descriptor({ account: { label: 'ada@example.test' } })],
    });
    expect(codexOption()).toBeEnabled();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    fireEvent.click(codexOption());
    expect(props.onSelectExternal).toHaveBeenCalledTimes(1);
  });

  // In a 320px panel the account badge and the fork hint on the name's line left
  // only the name free to shrink, and "Claude Code" read as "C…".
  it('keeps the agent name whole, with the account under it and the hint yielding', () => {
    renderSelector({
      hasTurns: true,
      runner: { kind: 'mangostudio', agentId: 'default' },
      externalAgents: [descriptor({ account: { label: 'ada@example.test' } })],
    });
    const option = codexOption();
    const name = within(option).getByText('Codex CLI');
    expect(name).not.toHaveClass('truncate');
    expect(within(option).getByText(/continue in a new chat/i)).toHaveClass('truncate');
    // Under the name, in the same block, never on the name's own line.
    expect(name.parentElement).not.toContainElement(within(option).getByText('ada@example.test'));
    expect(option).toHaveAccessibleDescription(/ada@example\.test/);
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

  /**
   * A reason is a diagnosis; a remedy is the next step. The two that MangoStudio
   * can actually do something about link into the surface that already owns the
   * install recipes, rather than growing a second install affordance here.
   */
  it.each([
    ['not-installed', /Install this agent/i],
    ['version-unsupported', /Update this agent/i],
  ] as const)('offers what would fix %s', (reason, action) => {
    renderSelector({
      externalAgents: [
        descriptor({
          unavailableReason: reason as ExternalAgentUnavailableReason,
          remedy: { kind: reason === 'not-installed' ? 'install' : 'update' },
          ...(reason === 'version-unsupported' ? { requiredVersion: '2.1.211' } : {}),
        }),
      ],
    });

    const link = screen.getByRole('link', { name: action });
    expect(link).toHaveAttribute('href', expect.stringContaining('/environments/agents'));
  });

  // The remedy is on the name's line, beside the agent it fixes, the way a usable
  // row puts "Continue in a new chat" there: the row is a name and a reason, not a
  // name, a reason and a link stacked under them, indented a second time.
  it('puts the remedy on the same line as the agent it is for', () => {
    renderSelector({
      externalAgents: [
        descriptor({ unavailableReason: 'not-installed', remedy: { kind: 'install' } }),
      ],
    });

    const link = screen.getByRole('link', { name: /Install this agent/i });
    // The link sits in a wrapper of its own, and the wrapper in the row with the name.
    expect(link.parentElement?.parentElement).toContainElement(codexOption());
  });

  it('offers no action for a refusal nothing on this screen fixes', () => {
    // `runtime-unsupported` is the runtime lacking an adapter, so updating the
    // *agent* would not help. A button that does nothing is worse than none.
    renderSelector({
      externalAgents: [
        descriptor({ unavailableReason: 'runtime-unsupported', remedy: { kind: 'none' } }),
      ],
    });

    expect(
      screen.queryByRole('link', { name: /Install this agent|Update this agent/i })
    ).toBeNull();
  });

  // Blocked until its notice is read, but selectable: picking it opens the
  // notice. The row says so — a warning glyph on the reason, and the notice as
  // its way through where a healthy row would offer a new chat.
  it('offers the notice, not a new chat, for a runner whose notice is unread', () => {
    const { props } = renderSelector({
      hasTurns: true,
      externalAgents: [
        descriptor({
          unavailableReason: 'disclosure-required',
          remedy: { kind: 'accept-disclosure' },
        }),
      ],
    });

    expect(codexOption()).toBeEnabled();
    expect(within(codexOption()).queryByText(/continue in a new chat/i)).toBeNull();
    expect(codexOption()).toHaveAccessibleDescription(/third-party notice/i);
    expect(codexOption().querySelector('.text-warning')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Read the notice' }));
    expect(props.onForkWithRunner).toHaveBeenCalledWith({ kind: 'external', targetId: 'codex' });
  });

  it('marks each row with the identity colour of the runner it picks', () => {
    renderSelector({
      externalAgents: [descriptor(), descriptor({ targetId: 'claude', installed: false })],
    });

    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getByRole('option', { name: /Default/ })
        .querySelector('.bg-agent-mango')
    ).not.toBeNull();
    expect(codexOption().querySelector('.bg-agent-codex')).not.toBeNull();
    // A runner that cannot run here keeps its colour; only its name steps down.
    expect(
      screen.getByRole('option', { name: /Claude Code/ }).querySelector('.bg-agent-claude')
    ).not.toBeNull();
  });

  it('never renders an executable path', () => {
    const { container } = renderSelector();
    expect(container.textContent ?? '').not.toMatch(/\/usr\/|\.exe|\/bin\//);
  });
});

/**
 * The one refusal whose fix is an administrative change to a machine rather
 * than a click, so the one-line reason is not enough on its own.
 *
 * The advice is chosen from the transport because the server will not say *why*
 * isolation failed — telling "attested nothing" apart from "attested a
 * credential home somebody else reaches" would confirm that another person uses
 * the machine.
 */
describe('isolation-unproven guidance', () => {
  function renderUnproven(transportKind?: EnvironmentTransportKind) {
    renderSelector({
      externalAgents: [descriptor({ unavailableReason: 'isolation-unproven' })],
      ...(transportKind ? { environmentTransportKind: transportKind } : {}),
    });
  }

  it.each([
    ['in-process', /single MangoStudio user/i],
    ['stdio', /single MangoStudio user/i],
    ['wsl', /own WSL user account/i],
    ['ssh', /own account on the remote host/i],
    ['container', /own container/i],
    ['websocket', /belongs to the person who paired it/i],
  ] as const)('tells a %s machine what would fix it', (transportKind, copy) => {
    renderUnproven(transportKind);
    expect(screen.getByText(/cannot keep vendor logins separate/i)).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  /**
   * A Direct URL machine was configured, not paired, so "pair your own" would
   * name a flow its owner never used.
   */
  it('falls back to the generic fix for a transport with no specific advice', () => {
    renderUnproven('http');
    expect(screen.getByText(/own operating-system account/i)).toBeInTheDocument();
  });

  it('says nothing extra when the machine is available', () => {
    renderSelector({ environmentTransportKind: 'ssh' });
    expect(screen.queryByText(/cannot keep vendor logins separate/i)).toBeNull();
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

  // The lock is on the runner, not just its kind: a within-kind move after the
  // first turn is still a different runner owning the transcript.
  it('forks another MangoStudio agent once the chat has turns, instead of switching in place', () => {
    const { props } = renderSelector({ hasTurns: true });
    fireEvent.click(screen.getByRole('option', { name: /Explore/ }));
    expect(props.onForkWithRunner).toHaveBeenCalledWith({
      kind: 'mangostudio',
      agentId: 'explore',
    });
    expect(props.onSelectAgent).not.toHaveBeenCalled();
  });

  it('forks a vendor swap from an external chat with turns', () => {
    const { props } = renderSelector({
      runner: { kind: 'external', targetId: 'claude' },
      externalAgents: [descriptor(), descriptor({ targetId: 'claude' })],
      hasTurns: true,
    });
    fireEvent.click(codexOption());
    expect(props.onForkWithRunner).toHaveBeenCalledWith({ kind: 'external', targetId: 'codex' });
    expect(props.onSelectExternal).not.toHaveBeenCalled();
  });

  it('never forks on re-picking the active agent', () => {
    const { props } = renderSelector({ hasTurns: true });
    fireEvent.click(screen.getByRole('option', { name: /Default/ }));
    expect(props.onForkWithRunner).not.toHaveBeenCalled();
  });
});

/**
 * The closed pill's own readout, which is a different question from the picker's:
 * not "may I choose this" but "can it take a turn right now". Discovery not
 * having answered yet is not the same answer as "no".
 */
describe('runner pill availability', () => {
  function renderPill(overrides: Partial<React.ComponentProps<typeof RunnerSelector>> = {}) {
    const props = {
      runner: { kind: 'external', targetId: 'codex' },
      agents: AGENTS,
      isAgentListLoading: false,
      externalAgents: [descriptor()],
      environmentName: 'this laptop',
      hasTurns: false,
      onSelectAgent: jest.fn(),
      onSelectExternal: jest.fn(),
      onForkWithRunner: jest.fn(),
      onBrowseSessions: jest.fn(),
      ...overrides,
    } as React.ComponentProps<typeof RunnerSelector>;
    render(<RunnerSelector {...props} />);
    return screen.getByRole('button', { name: /who runs this chat/i });
  }

  // The availability glyph after the name; `null` when the runner is ready.
  const toneOf = (pill: HTMLElement) =>
    pill.querySelector('[data-availability]')?.getAttribute('data-availability') ?? null;
  const dotOf = (pill: HTMLElement) => pill.querySelector('[data-tone]');

  it('reads signed in for a usable descriptor, with no status glyph', () => {
    const pill = renderPill();
    expect(within(pill).getByText('signed in')).toBeInTheDocument();
    expect(pill).toHaveAccessibleDescription('signed in');
    expect(toneOf(pill)).toBeNull();
  });

  // The dot is the runner's identity — the colour the sidebar, the palette and
  // Home draw for it — never its availability, and never the accent.
  it('draws the runner identity dot, whatever the availability', () => {
    const codex = renderPill();
    expect(dotOf(codex)).toHaveClass('bg-agent-codex');
    expect(dotOf(codex)).not.toHaveClass('bg-success');
  });

  it('draws MangoStudio in its own identity colour with no status glyph', () => {
    const pill = renderPill({ runner: { kind: 'mangostudio', agentId: 'default' } });
    expect(dotOf(pill)).toHaveClass('bg-agent-mango');
    expect(dotOf(pill)).not.toHaveClass('bg-accent');
    expect(toneOf(pill)).toBeNull();
  });

  it('does not claim the agent is unavailable while discovery is still answering', () => {
    const pill = renderPill({ externalAgents: [], isExternalAgentListLoading: true });
    expect(within(pill).queryByText(/cannot run here/i)).toBeNull();
    expect(toneOf(pill)).toBe('loading');
  });

  it('reports unavailable once discovery answered without the descriptor', () => {
    const pill = renderPill({ externalAgents: [], isExternalAgentListLoading: false });
    expect(within(pill).getByText(/cannot run here/i)).toBeInTheDocument();
    expect(toneOf(pill)).toBe('error');
  });

  // A healthy account's header must not open on red: absent and optional is
  // neutral, fixable is warning, and error is kept for a fault.
  it.each([
    ['not-installed', 'neutral', /not installed on this machine/i],
    ['runtime-unsupported', 'neutral', /cannot host it/i],
    ['signed-out', 'warning', /installed, but signed out/i],
    ['disclosure-required', 'warning', /third-party notice/i],
    ['runtime-denied', 'warning', /has not allowed external agents/i],
    ['installed-but-unusable', 'warning', /accepts none of the permissions/i],
    ['environment-unreachable', 'error', /could not reach this machine/i],
    ['isolation-unproven', 'error', /not proven it keeps credentials separate/i],
  ] as const)('grades %s as %s and says why', (reason, tone, sentence) => {
    const pill = renderPill({
      externalAgents: [
        descriptor({
          unavailableReason: reason,
          ...(reason === 'not-installed' ? { installed: false } : {}),
        }),
      ],
    });
    expect(toneOf(pill)).toBe(tone);
    expect(within(pill).getByText(sentence)).toBeInTheDocument();
    expect(within(pill).queryByText(/cannot run here/i)).toBeNull();
  });

  it('reads an untyped signed-out or absent agent the same way', () => {
    const signedOut = renderPill({
      externalAgents: [descriptor({ authState: 'signed-out' })],
    });
    expect(toneOf(signedOut)).toBe('warning');
    expect(within(signedOut).getByText(/signed out/i)).toBeInTheDocument();
  });

  // The sidebar badge already degrades this way; the pill must not be the one
  // surface that goes blank on a chat a newer build wrote.
  it('names a target this bundle has no label for instead of rendering blank', () => {
    const pill = renderPill({
      runner: { kind: 'external', targetId: 'gemini' } as unknown as React.ComponentProps<
        typeof RunnerSelector
      >['runner'],
      externalAgents: [],
    });
    expect(within(pill).getByText('gemini')).toBeInTheDocument();
  });
});
