/**
 * The notice above a composer whose external runner cannot take a turn.
 *
 * It used to be one concatenated line - the selector's reason, an em dash, then
 * "pick another" - which named the cause and offered nothing for it, and told a
 * signed-out user to pick another agent when the fix is one command. The words
 * for a reason are the selector's own, and the way out is the control the
 * header's runner selector already draws.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen } from '@testing-library/react';
import { render } from '../../../support/harness/render';
import { routerWithLinkStub } from '../../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());

const { ExternalRunnerBlockedCallout } = await import(
  '../../../../src/features/chat/components/ExternalRunnerBlockedCallout'
);

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'claude',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...overrides,
  };
}

describe('ExternalRunnerBlockedCallout', () => {
  it('offers the vendor sign-in command, not "pick another", to a signed-out agent', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({
          authState: 'signed-out',
          unavailableReason: 'signed-out',
          loginCommand: 'claude auth login',
          remedy: { kind: 'sign-in', command: 'claude auth login' },
        })}
      />
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Installed, but signed out');
    expect(notice).toHaveTextContent('claude auth login');
    expect(screen.getByRole('button', { name: 'Copy login command' })).toBeInTheDocument();
    expect(notice).not.toHaveTextContent(/pick another/i);
    expect(notice.textContent).not.toContain('—');
  });

  // The descriptor can be refused for being signed out without the runtime
  // having attached a reason to it; the notice still has to say which.
  it('names a signed-out agent whose descriptor carries no reason', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({ authState: 'signed-out', loginCommand: 'claude auth login' })}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Installed, but signed out');
    expect(screen.getByRole('status')).toHaveTextContent('claude auth login');
  });

  it('links an uninstalled agent to where the install recipes live', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({
          installed: false,
          unavailableReason: 'not-installed',
          remedy: { kind: 'install' },
        })}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Not installed on this machine');
    expect(screen.getByRole('link', { name: 'Install this agent' })).toHaveAttribute(
      'href',
      '/environments/agents'
    );
  });

  // The raw `unavailable[reason]` lookup left a literal `{version}` here.
  it('fills in the version an unsupported agent has to be updated to', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({
          unavailableReason: 'version-unsupported',
          requiredVersion: '2.1.0',
          remedy: { kind: 'update' },
        })}
      />
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Update this agent to 2.1.0 or later on this machine');
    expect(notice.textContent).not.toContain('{version}');
    expect(screen.getByRole('link', { name: 'Update this agent' })).toBeInTheDocument();
  });

  it('suggests another runner when a reason has nothing to click', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({
          unavailableReason: 'runtime-denied',
          remedy: { kind: 'contact-admin' },
        })}
      />
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent("This machine's owner has not allowed external agents");
    expect(notice).toHaveTextContent('Pick another runner in the header');
  });

  it('does not point away from the notice a disclosure-required agent needs read', () => {
    render(
      <ExternalRunnerBlockedCallout
        descriptor={descriptor({
          unavailableReason: 'disclosure-required',
          remedy: { kind: 'accept-disclosure' },
        })}
      />
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('third-party notice first');
    expect(notice).not.toHaveTextContent(/pick another/i);
  });

  it('says the agent cannot run, and what to try, while discovery has no answer', () => {
    render(<ExternalRunnerBlockedCallout descriptor={undefined} />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('This agent cannot run here right now.');
    expect(notice).toHaveTextContent('Pick another runner in the header');
    expect(notice.textContent).not.toContain('—');
  });
});
