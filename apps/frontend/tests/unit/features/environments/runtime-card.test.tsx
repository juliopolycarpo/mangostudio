/**
 * RuntimeCard: the effective binary leads, aliases collapse, and a shadowing
 * finding names both paths and both PATH positions.
 */

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCard } from '../../../../src/features/environments/components/RuntimeCard';
import { render, screen, within } from '../../../support/harness/render';
import { installation, installRecipe, runtimeStatus } from './fixtures';

describe('RuntimeCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
        }),
      ],
    });

    render(<RuntimeCard status={status} recipes={[]} />);

    const effective = screen.getByTestId('effective-installation');
    expect(within(effective).getByText('22.13.0')).toBeInTheDocument();
    expect(within(effective).getByText(/\.nvm\/versions\/node\/v22\.13\.0/)).toBeInTheDocument();
    // PATH positions are one-based on screen: index 1 is the second entry.
    expect(within(effective).getByText(/PATH #2/)).toBeInTheDocument();
    expect(within(effective).getByText(/managed by nvm/)).toBeInTheDocument();
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

  it('says a failed re-check failed instead of leaving the card silently stale', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'probe failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const status = runtimeStatus({ id: 'bun' });

    render(<RuntimeCard status={status} recipes={[]} />);
    await userEvent.click(screen.getByRole('button', { name: en.environments.actions.refresh }));

    // The card keeps rendering its last known state, so a probe that failed has
    // to say so — otherwise the spinner stopping reads as "nothing changed".
    expect(await screen.findByTestId('probe-error')).toHaveTextContent(
      en.environments.actions.refreshFailed
    );
  });
});
