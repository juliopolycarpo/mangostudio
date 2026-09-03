/**
 * RuntimeCard: the effective binary leads, aliases collapse, and a shadowing
 * finding names both paths and both PATH positions.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { RuntimeCard } from '../../../../src/features/environments/components/RuntimeCard';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { installation, installRecipe, runtimeStatus } from './fixtures';

describe('RuntimeCard', () => {
  it('renders the effective installation first regardless of array order', () => {
    const status = runtimeStatus({
      id: 'node',
      installations: [
        installation({
          path: '/usr/local/bin/node',
          version: '20.11.0',
          pathIndex: 0,
        }),
        installation({
          path: '/home/dev/.nvm/versions/node/v22.13.0/bin/node',
          version: '22.13.0',
          pathIndex: 1,
          effective: true,
          managedBy: 'nvm',
          pathSource: 'nvm',
        }),
      ],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    const effective = screen.getByTestId('effective-installation');
    expect(within(effective).getByText('22.13.0')).toBeInTheDocument();
    expect(within(effective).getByText(/\.nvm\/versions\/node\/v22\.13\.0/)).toBeInTheDocument();
    // PATH positions are one-based on screen: index 1 is the second entry.
    expect(within(effective).getByText(/PATH #2/)).toBeInTheDocument();
    expect(within(effective).getByText(/from nvm/)).toBeInTheDocument();
  });

  it('states the consequence of a shadowing finding with both paths and positions', () => {
    const status = runtimeStatus({
      id: 'node',
      health: 'warn',
      installations: [
        installation({ path: '/usr/local/bin/node', version: '20.11.0', pathIndex: 0 }),
        installation({
          path: '/home/dev/.nvm/versions/node/v22.13.0/bin/node',
          version: '22.13.0',
          pathIndex: 1,
          effective: true,
        }),
      ],
      findings: [
        {
          code: 'shadowed-by-earlier-path',
          params: {
            effectivePath: '/home/dev/.nvm/versions/node/v22.13.0/bin/node',
            effectivePathIndex: '1',
            shadowedPath: '/usr/local/bin/node',
            shadowedPathIndex: '0',
          },
        },
      ],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    const finding = screen.getByTestId('finding-list').textContent ?? '';
    expect(finding).toContain('/usr/local/bin/node');
    expect(finding).toContain('/home/dev/.nvm/versions/node/v22.13.0/bin/node');
    expect(finding).toContain('PATH #1');
    expect(finding).toContain('PATH #2');
  });

  it('collapses an alias chain into one row with a reachable-via affordance', () => {
    const status = runtimeStatus({
      id: 'node',
      installations: [
        installation({
          path: '/opt/node/bin/node',
          version: '22.13.0',
          pathIndex: 0,
          effective: true,
        }),
        installation({
          path: '/opt/node/bin/node',
          rawPath: '/usr/local/bin/node',
          version: '22.13.0',
          pathIndex: 1,
          aliasOf: '/opt/node/bin/node',
        }),
        installation({ path: '/usr/bin/node', version: '18.19.0', pathIndex: 2 }),
      ],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    // Three installations, two distinct binaries: the alias is an affordance on
    // the effective row, not a second row.
    expect(
      screen.getByText(en.environments.runtimes.versionCount.replace('{count}', '2'))
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('installation-row')).toHaveLength(1);
    expect(screen.getByTestId('effective-installation').textContent).toContain(
      'reachable via 2 paths'
    );
  });

  it('names fnm as a Node version manager, alongside its own version count', () => {
    const status = runtimeStatus({
      id: 'fnm',
      installations: [
        installation({ path: '/usr/local/bin/fnm', version: '1.38.0', effective: true }),
      ],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    expect(screen.getByText(en.environments.runtimes.nodeVersionManager)).toBeInTheDocument();
    expect(screen.getByText(en.environments.runtimes.singleVersion)).toBeInTheDocument();
  });

  it('reads as an offer, not a failure, when nothing is installed', () => {
    const status = runtimeStatus({ id: 'bun', health: 'missing', installations: [] });

    render(<RuntimeCard status={status} recipes={[]} />);

    expect(screen.getByText('Bun is not installed yet.')).toBeInTheDocument();
  });

  it('closes on an action or on nothing, never on an empty footer', () => {
    // Only some runtimes have an update recipe, so an installed one that has
    // none is the common case, not an edge: the card must not end on an empty
    // row and the gap above it.
    // Node is installed and the registry has no update recipe for it.
    const node = runtimeStatus({
      id: 'node',
      installations: [installation({ path: '/usr/local/bin/node', version: '22.13.0' })],
    });

    const { container, rerender } = render(<RuntimeCard status={node} recipes={[]} />);
    expect(container.querySelector('footer')).toBeNull();

    // Bun is installed and does have one, so that card still closes on it.
    rerender(
      <RuntimeCard
        status={runtimeStatus({
          id: 'bun',
          installations: [installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14' })],
        })}
        recipes={[installRecipe({ id: 'bun.update', runtimeId: 'bun', action: 'update' })]}
      />
    );
    expect(container.querySelector('footer')).not.toBeNull();
  });

  it('offers Uninstall after Update when the registry has a recipe and the tool is installed', () => {
    const status = runtimeStatus({
      id: 'bun',
      installations: [installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14' })],
    });

    render(
      <RuntimeCard
        status={status}
        recipes={[
          installRecipe({ id: 'bun.update', runtimeId: 'bun', action: 'update' }),
          installRecipe({ id: 'bun.uninstall', runtimeId: 'bun', action: 'uninstall' }),
        ]}
      />
    );

    const footer = screen.getByRole('button', {
      name: en.environments.runtimes.update.replace('{runtime}', 'Bun'),
    });
    const uninstall = screen.getByRole('button', {
      name: en.environments.runtimes.uninstall.replace('{runtime}', 'Bun'),
    });
    expect(footer).toBeInTheDocument();
    expect(uninstall).toBeInTheDocument();
    // Uninstall reads as secondary, after Update — never the button someone
    // reaches for first.
    expect(
      footer.compareDocumentPosition(uninstall) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('offers no Uninstall when the registry has no recipe for the runtime', () => {
    const status = runtimeStatus({
      id: 'node',
      installations: [installation({ path: '/usr/local/bin/node', version: '22.13.0' })],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    expect(
      screen.queryByRole('button', {
        name: en.environments.runtimes.uninstall.replace('{runtime}', 'Node.js'),
      })
    ).not.toBeInTheDocument();
  });

  describe('Node update affordance', () => {
    const NVM_INSTALL = installRecipe({
      id: 'nvm.node.install',
      runtimeId: 'node',
      action: 'use-version',
      inputKind: 'node-version',
    });
    const NVM_SET_DEFAULT = installRecipe({
      id: 'nvm.node.set-default',
      runtimeId: 'node',
      action: 'set-default',
      inputKind: 'node-version',
    });
    const NODE_CATALOG = [NVM_INSTALL, NVM_SET_DEFAULT];

    function nvmManagedNode() {
      return runtimeStatus({
        id: 'node',
        installations: [
          installation({
            path: '/home/dev/.nvm/versions/node/v20/bin/node',
            version: '20.11.0',
            effective: true,
            pathSource: 'nvm',
          }),
        ],
      });
    }

    it('offers Update Node for an nvm-managed install', () => {
      render(<RuntimeCard status={nvmManagedNode()} recipes={NODE_CATALOG} />);

      expect(
        screen.getByRole('button', {
          name: en.environments.runtimes.update.replace('{runtime}', 'Node.js'),
        })
      ).toBeInTheDocument();
    });

    it('reads "managed elsewhere" instead of a button for a Volta-managed install', () => {
      const status = runtimeStatus({
        id: 'node',
        installations: [
          installation({
            path: '/home/dev/.volta/bin/node',
            version: '20.11.0',
            effective: true,
            pathSource: 'volta',
          }),
        ],
      });

      render(<RuntimeCard status={status} recipes={NODE_CATALOG} />);

      expect(screen.getByTestId('node-managed-elsewhere').textContent).toBe(
        en.environments.runtimes.managedElsewhere.replace('{manager}', 'Volta')
      );
      expect(
        screen.queryByRole('button', {
          name: en.environments.runtimes.update.replace('{runtime}', 'Node.js'),
        })
      ).not.toBeInTheDocument();
    });

    it('reads its own full sentence, not the {manager} template, for a plain system install', () => {
      // "Managed by {manager}" cannot carry a bare "the system" without an
      // article in every locale ("por o sistema" is not Portuguese), so this
      // is a dedicated string rather than a name plugged into the template.
      const status = runtimeStatus({
        id: 'node',
        installations: [
          installation({ path: '/usr/bin/node', version: '20.11.0', effective: true }),
        ],
      });

      render(<RuntimeCard status={status} recipes={NODE_CATALOG} />);

      expect(screen.getByTestId('node-managed-elsewhere').textContent).toBe(
        en.environments.runtimes.managedBySystem
      );
    });
  });

  it('says a failed re-check failed instead of leaving the card silently stale', async () => {
    // `vi.stubGlobal` has no Bun equivalent. `bun.setup.ts` reinstates its
    // unreachable `fetch` after every test, so a plain assignment cannot leak.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'probe failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )) as unknown as typeof fetch;
    const status = runtimeStatus({ id: 'bun' });

    render(<RuntimeCard status={status} recipes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: en.environments.actions.refresh }));

    // The card keeps rendering its last known state, so a probe that failed has
    // to say so — otherwise the spinner stopping reads as "nothing changed".
    expect(await screen.findByTestId('probe-error')).toHaveTextContent(
      en.environments.actions.refreshFailed
    );
  });

  describe('toolchain pin', () => {
    const scenario = createFetchScenario();

    afterEach(() => {
      scenario.restore();
    });

    function nodeWithTwoInstallations() {
      return runtimeStatus({
        id: 'node',
        installations: [
          installation({
            path: '/home/dev/.nvm/versions/node/v20/bin/node',
            version: '20.11.0',
            effective: true,
            pathIndex: 0,
            pathSource: 'nvm',
          }),
          installation({
            path: '/opt/node/bin/node',
            version: '18.19.0',
            pathIndex: 1,
          }),
        ],
      });
    }

    function localEnvironment(toolchain?: Environment['toolchain']): Environment {
      return {
        id: 'local',
        name: 'Local',
        transportKind: 'in-process',
        config: {},
        enabled: true,
        allowInstalls: false,
        virtual: true,
        createdAt: null,
        updatedAt: null,
        status: { state: 'connected' },
        ...(toolchain && { toolchain }),
      };
    }

    function installEnvironmentsScenario(toolchain?: Environment['toolchain']) {
      scenario.respondWithJson('GET', '/api/environments', { body: [localEnvironment(toolchain)] });
      scenario.install();
    }

    function putCalls(): RequestInit[] {
      return scenario.fetchMock.mock.calls
        .filter(([, init]) => init?.method?.toUpperCase() === 'PUT')
        .map(([, init]) => init as RequestInit);
    }

    it('offers "Use this version" for every installation when nothing is pinned', async () => {
      installEnvironmentsScenario();

      render(<RuntimeCard status={nodeWithTwoInstallations()} recipes={[]} />);

      expect(
        await screen.findAllByRole('button', { name: en.environments.runtimes.useThisVersion })
      ).toHaveLength(2);
      expect(screen.queryByTestId('toolchain-selected')).not.toBeInTheDocument();
    });

    it('shows the Selected badge on the pinned installation instead of the button', async () => {
      installEnvironmentsScenario({ node: '/opt/node/bin/node', bun: 'auto' });

      render(<RuntimeCard status={nodeWithTwoInstallations()} recipes={[]} />);

      expect(await screen.findByTestId('toolchain-selected')).toHaveTextContent(
        en.environments.runtimes.selected
      );
      // The effective installation is no longer the pin, so it still offers the button.
      expect(
        await screen.findAllByRole('button', { name: en.environments.runtimes.useThisVersion })
      ).toHaveLength(1);
    });

    it('writes the installation path when "Use this version" is clicked', async () => {
      const user = userEvent.setup();
      installEnvironmentsScenario();
      scenario.respondWithJson('PUT', '/api/environments/local/toolchain', {
        body: { node: '/opt/node/bin/node', bun: 'auto' },
      });

      render(<RuntimeCard status={nodeWithTwoInstallations()} recipes={[]} />);

      const buttons = await screen.findAllByRole('button', {
        name: en.environments.runtimes.useThisVersion,
      });
      // Effective-first: the second button belongs to the non-effective
      // installation, /opt/node/bin/node.
      await user.click(buttons[1] as HTMLElement);

      await waitFor(() => expect(putCalls()).toHaveLength(1));
      expect(JSON.parse(String(putCalls()[0]?.body))).toEqual({ node: '/opt/node/bin/node' });
    });

    it('writes auto when "Back to automatic" is clicked', async () => {
      const user = userEvent.setup();
      installEnvironmentsScenario({ node: '/opt/node/bin/node', bun: 'auto' });
      scenario.respondWithJson('PUT', '/api/environments/local/toolchain', {
        body: { node: 'auto', bun: 'auto' },
      });

      render(<RuntimeCard status={nodeWithTwoInstallations()} recipes={[]} />);

      const resetButton = await screen.findByRole('button', {
        name: en.environments.runtimes.backToAutomatic,
      });
      await user.click(resetButton);

      await waitFor(() => expect(putCalls()).toHaveLength(1));
      expect(JSON.parse(String(putCalls()[0]?.body))).toEqual({ node: 'auto' });
    });

    it('renders the 422 message when the write is rejected', async () => {
      const user = userEvent.setup();
      const message =
        'Invalid node toolchain path: expected one of: /opt/node/bin/node | received: /bogus';
      installEnvironmentsScenario();
      scenario.respondWithJson('PUT', '/api/environments/local/toolchain', {
        status: 422,
        body: { error: message, code: 'validation_error' },
      });

      render(<RuntimeCard status={nodeWithTwoInstallations()} recipes={[]} />);

      const buttons = await screen.findAllByRole('button', {
        name: en.environments.runtimes.useThisVersion,
      });
      await user.click(buttons[1] as HTMLElement);

      expect(await screen.findByText(message)).toBeInTheDocument();
    });
  });
});
