/**
 * InstallAction: a guard-blocked recipe degrades to a copyable command and
 * never issues an install request, and a run that finishes keeps its console.
 */

import type { InstallStreamEvent } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAction } from '../../../../src/features/environments/components/InstallAction';
import { render, screen, waitFor } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * One SSE frame per chunk, as the real server writes them. The exit must land in
 * its own read for the console to be observed across the step change it causes.
 */
function sseResponse(events: readonly InstallStreamEvent[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const event = events[index];
      if (!event) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('InstallAction', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the copyable command and issues no request when a guard refuses', async () => {
    const recipe = installRecipe({
      guard: { allowed: false, reasons: ['server-not-loopback'] },
    });

    render(<InstallAction recipe={recipe} input={{ kind: 'none' }} label="Install Bun" />);
    await userEvent.click(screen.getByRole('button', { name: 'Install Bun' }));

    const block = screen.getByTestId('copy-command-block');
    expect(block.textContent).toContain(recipe.copyCommand);
    expect(block.textContent).toContain(
      en.environments.install.guardBlocked['server-not-loopback']
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a missing requirement instead of firing a doomed request', async () => {
    const recipe = installRecipe({
      id: 'nvm.node.install',
      runtimeId: 'node',
      requires: ['nvm'],
      missingRequirements: ['nvm'],
      copyCommand: 'nvm install --lts',
    });

    render(<InstallAction recipe={recipe} input={{ kind: 'none' }} label="Install LTS" />);
    await userEvent.click(screen.getByRole('button', { name: 'Install LTS' }));

    expect(screen.getByTestId('copy-command-block').textContent).toContain('Install first: nvm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the server never offered the recipe', () => {
    render(<InstallAction recipe={undefined} input={{ kind: 'none' }} label="Install Bun" />);

    expect(screen.queryByRole('button', { name: 'Install Bun' })).not.toBeInTheDocument();
  });

  it('keeps the console and its output after the run exits', async () => {
    const recipe = installRecipe();
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/install/prepare')) {
        return Promise.resolve(json({ preparationId: 'prep-1', expiresAt: null, recipe }));
      }
      if (url.includes('/log')) {
        return Promise.resolve(
          sseResponse([
            { type: 'log', stream: 'stdout', line: 'unpacking', done: false },
            {
              type: 'exit',
              code: 0,
              status: 'succeeded',
              truncated: false,
              durationMs: 1200,
              done: true,
            },
          ])
        );
      }
      return Promise.resolve(json({ runId: 'run-1', attached: true }));
    });

    render(<InstallAction recipe={recipe} input={{ kind: 'none' }} label="Install Bun" />);
    await userEvent.click(screen.getByRole('button', { name: 'Install Bun' }));

    await screen.findByTestId('install-argv');
    await userEvent.click(screen.getByRole('button', { name: en.environments.install.run }));

    // The exit moves the flow to `finished`; the console it produced must not be
    // torn down along with the run that filled it.
    await waitFor(() =>
      expect(screen.getByTestId('install-console').textContent).toContain('unpacking')
    );
    expect(screen.getByTestId('install-console').textContent).toContain(
      en.environments.install.runStatus.succeeded
    );
    expect(screen.getByTestId('install-exit-summary')).toBeInTheDocument();
  });
});
