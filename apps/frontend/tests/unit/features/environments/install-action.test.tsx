/**
 * InstallAction: a guard-blocked recipe degrades to a copyable command and
 * never issues an install request, a missing requirement becomes the chain that
 * satisfies it — or a sentence when nothing here can — and a run that finishes
 * keeps its console.
 */

import type { InstallStreamEvent } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAction } from '../../../../src/features/environments/components/InstallAction';
import { render, screen, waitFor } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

const NVM_RECIPE = installRecipe({
  id: 'nvm.install',
  runtimeId: 'nvm',
  action: 'install',
  argv: ['bash', '/tmp/nvm-installer.sh'],
  writes: ['$NVM_DIR'],
  copyCommand: 'curl -fsSL https://example.test/nvm | bash',
});

const NODE_RECIPE = installRecipe({
  id: 'nvm.node.install',
  runtimeId: 'node',
  action: 'use-version',
  inputKind: 'node-version',
  argv: ['bash', '-c', 'nvm install "$1"', 'mangostudio-install', 'lts/*'],
  requires: ['nvm'],
  missingRequirements: ['nvm'],
  writes: ['$NVM_DIR/versions/node'],
  copyCommand: 'nvm install lts/*',
});

const CHAIN_LABEL = 'Install nvm, then Node.js';

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

/** `start` is a POST to the install collection itself; every sibling has a suffix. */
function isStartRequest(url: string): boolean {
  return url.replace(/[?#].*$/, '').endsWith('/api/environments/install');
}

function exitEvent(status: 'succeeded' | 'failed'): InstallStreamEvent {
  return {
    type: 'exit',
    code: status === 'succeeded' ? 0 : 1,
    status,
    truncated: false,
    durationMs: 1200,
    done: true,
  };
}

describe('InstallAction', () => {
  const fetchMock = vi.fn();

  /**
   * Requests aimed at the install endpoints. The card also reads unrelated data
   * (tool identities), so "no doomed install" has to be asserted against the
   * endpoint rather than against the whole fetch mock.
   */
  function installRequests(): unknown[][] {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/api/environments/install')
    );
  }

  /** The recipe id each `start` call carried, in the order the calls were made. */
  function startedRecipeIds(): string[] {
    return fetchMock.mock.calls
      .filter(([input]) => isStartRequest(String(input)))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).recipeId as string);
  }

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

    render(
      <InstallAction
        recipe={recipe}
        catalog={[recipe]}
        input={{ kind: 'none' }}
        label="Install Bun"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Install Bun' }));

    const block = screen.getByTestId('copy-command-block');
    expect(block.textContent).toContain(recipe.copyCommand);
    expect(block.textContent).toContain(
      en.environments.install.guardBlocked['server-not-loopback']
    );
    expect(installRequests()).toHaveLength(0);
  });

  it('states the requirement instead of offering a button nothing here can satisfy', () => {
    // The catalog has no nvm recipe, so no chain reaches Node on this machine.
    render(
      <InstallAction
        recipe={NODE_RECIPE}
        catalog={[NODE_RECIPE]}
        input={{ kind: 'node-version', version: 'lts' }}
        label="Install LTS"
      />
    );

    expect(screen.getByTestId('install-unresolved').textContent).toContain(
      'MangoStudio cannot install nvm on this machine'
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(installRequests()).toHaveLength(0);
  });

  it('offers the prerequisite chain and runs its steps in order', async () => {
    let prepared = 0;
    fetchMock.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/install/prepare')) {
        prepared += 1;
        const recipe = prepared === 1 ? NVM_RECIPE : NODE_RECIPE;
        return Promise.resolve(
          json({ preparationId: `prep-${prepared}`, expiresAt: null, recipe })
        );
      }
      if (isStartRequest(url)) {
        const { recipeId } = JSON.parse(String(init?.body)) as { recipeId: string };
        return Promise.resolve(json({ runId: `run-${recipeId}`, attached: false }));
      }
      if (url.includes('/log')) {
        const line = url.includes('nvm.install') ? 'installing nvm' : 'installing node';
        return Promise.resolve(
          sseResponse([
            { type: 'log', stream: 'stdout', line, done: false },
            exitEvent('succeeded'),
          ])
        );
      }
      return Promise.resolve(json({}));
    });

    render(
      <InstallAction
        recipe={NODE_RECIPE}
        catalog={[NVM_RECIPE, NODE_RECIPE]}
        input={{ kind: 'node-version', version: 'lts' }}
        label="Install LTS"
      />
    );

    // One affordance for the whole chain, not a bare install that would 409.
    await userEvent.click(screen.getByRole('button', { name: CHAIN_LABEL }));

    // One dialog, both commands, in the order they will run.
    const steps = await screen.findAllByTestId('install-step');
    expect(steps).toHaveLength(2);
    expect(steps[0]?.textContent).toContain('Step 1 of 2 · nvm');
    expect(steps[1]?.textContent).toContain('Step 2 of 2 · Node.js');

    await userEvent.click(screen.getByRole('button', { name: en.environments.install.run }));

    await waitFor(() => expect(startedRecipeIds()).toEqual(['nvm.install', 'nvm.node.install']));
    await waitFor(() =>
      expect(screen.getByTestId('install-console').textContent).toContain('installing node')
    );
    expect(screen.getByTestId('install-step-label').textContent).toBe('Step 2 of 2 · Node.js');
  });

  it('stops the chain and says so when a prerequisite does not finish', async () => {
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/install/prepare')) {
        return Promise.resolve(
          json({ preparationId: 'prep-1', expiresAt: null, recipe: NVM_RECIPE })
        );
      }
      if (isStartRequest(url)) {
        return Promise.resolve(json({ runId: 'run-nvm', attached: false }));
      }
      if (url.includes('/log')) {
        return Promise.resolve(
          sseResponse([
            { type: 'log', stream: 'stderr', line: 'download failed', done: false },
            exitEvent('failed'),
          ])
        );
      }
      return Promise.resolve(json({}));
    });

    render(
      <InstallAction
        recipe={NODE_RECIPE}
        catalog={[NVM_RECIPE, NODE_RECIPE]}
        input={{ kind: 'node-version', version: 'lts' }}
        label="Install LTS"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: CHAIN_LABEL }));
    await screen.findAllByTestId('install-step');
    await userEvent.click(screen.getByRole('button', { name: en.environments.install.run }));

    // Node on top of an nvm that never arrived would fail with a worse message
    // than the one already on screen, so the second step is never attempted.
    await waitFor(() =>
      expect(screen.getByTestId('install-chain-stopped').textContent).toContain(
        'Node.js was not installed'
      )
    );
    expect(startedRecipeIds()).toEqual(['nvm.install']);
  });

  it('renders nothing when the server never offered the recipe', () => {
    render(
      <InstallAction recipe={undefined} catalog={[]} input={{ kind: 'none' }} label="Install Bun" />
    );

    expect(screen.queryByRole('button', { name: 'Install Bun' })).not.toBeInTheDocument();
  });

  it('quotes an argument containing whitespace in the confirmation', async () => {
    const recipe = installRecipe({ argv: ['bash', '/tmp/mango installer.sh'] });
    fetchMock.mockImplementation(() =>
      Promise.resolve(json({ preparationId: 'prep-1', expiresAt: null, recipe }))
    );

    render(
      <InstallAction
        recipe={recipe}
        catalog={[recipe]}
        input={{ kind: 'none' }}
        label="Install Bun"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Install Bun' }));

    // The dialog exists to show what will run; a path with a space in it must
    // not be displayed as two arguments.
    expect((await screen.findByTestId('install-argv')).textContent).toBe(
      "bash '/tmp/mango installer.sh'"
    );
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
            exitEvent('succeeded'),
          ])
        );
      }
      return Promise.resolve(json({ runId: 'run-1', attached: true }));
    });

    render(
      <InstallAction
        recipe={recipe}
        catalog={[recipe]}
        input={{ kind: 'none' }}
        label="Install Bun"
      />
    );
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
    // A lone install is not a chain, so nothing labels it as a step.
    expect(screen.queryByTestId('install-step-label')).not.toBeInTheDocument();
  });
});
