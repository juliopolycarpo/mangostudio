/**
 * NodeVersionTable: every LTS status maps to its badge, `unknown` stays neutral
 * without offering an upgrade, and a machine without nvm is offered the chain
 * that reaches a Node rather than an install the server would refuse.
 */

import type { LtsStatus, ManagedVersion } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeVersionTable } from '../../../../src/features/environments/components/NodeVersionTable';
import { render, screen } from '../../../support/harness/render';
import { installRecipe, versionManagerStatus } from './fixtures';

function managedVersion(version: string, ltsStatus: LtsStatus): ManagedVersion {
  return {
    version,
    path: `/home/dev/.nvm/versions/node/v${version}`,
    isDefault: false,
    isCurrent: false,
    ltsStatus,
  };
}

const NODE_INSTALL_RECIPE = installRecipe({
  id: 'nvm.node.install',
  runtimeId: 'node',
  action: 'use-version',
  inputKind: 'node-version',
  requires: ['nvm'],
  copyCommand: 'nvm install --lts',
});

/** The same recipe as the catalog reports it on a machine that has no nvm. */
const NODE_WITHOUT_NVM = installRecipe({
  ...NODE_INSTALL_RECIPE,
  missingRequirements: ['nvm'],
});

const NVM_INSTALL_RECIPE = installRecipe({
  id: 'nvm.install',
  runtimeId: 'nvm',
  action: 'install',
  writes: ['$NVM_DIR'],
  copyCommand: 'curl -fsSL https://example.test/nvm | bash',
});

describe('NodeVersionTable', () => {
  it('maps each LTS status to its own badge', () => {
    const statuses: LtsStatus[] = [
      'current-lts',
      'lts-outdated-patch',
      'lts-superseded',
      'end-of-life',
      'current-release',
      'unknown',
    ];
    const status = versionManagerStatus({
      versions: statuses.map((ltsStatus, index) => managedVersion(`2${index}.0.0`, ltsStatus)),
    });

    render(<NodeVersionTable status={status} recipes={[]} />);

    for (const ltsStatus of statuses) {
      const badge = screen.getByText(en.environments.lts[ltsStatus]);
      expect(badge).toHaveAttribute('data-lts-status', ltsStatus);
    }
  });

  it('offers no upgrade when every version has an unknown LTS status', () => {
    const status = versionManagerStatus({
      versions: [
        managedVersion('22.13.0', 'unknown'),
        managedVersion('20.11.0', 'current-release'),
      ],
    });

    render(<NodeVersionTable status={status} recipes={[NODE_INSTALL_RECIPE]} />);

    // Stale, offline LTS data is a state, not a defect: nothing to upgrade to.
    expect(screen.queryByText(en.environments.versions.installLts)).not.toBeInTheDocument();
  });

  it('offers an upgrade next to a superseded release', () => {
    const status = versionManagerStatus({
      versions: [managedVersion('20.11.0', 'lts-superseded')],
    });

    render(<NodeVersionTable status={status} recipes={[NODE_INSTALL_RECIPE]} />);

    expect(screen.getByText(en.environments.versions.installLts)).toBeInTheDocument();
  });

  describe('without nvm', () => {
    const status = versionManagerStatus({ installed: false });
    const fetchMock = vi.fn();

    beforeEach(() => {
      // Only the identity registry is read here: the card has to derive its
      // affordance from the recipes it was handed, not from a request.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
      );
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      fetchMock.mockReset();
      vi.unstubAllGlobals();
    });

    it('offers the nvm to Node chain as one affordance', () => {
      render(<NodeVersionTable status={status} recipes={[NVM_INSTALL_RECIPE, NODE_WITHOUT_NVM]} />);

      expect(screen.getByRole('button', { name: 'Install nvm, then Node.js' })).toBeInTheDocument();
      // Not two buttons the user has to sequence themselves.
      expect(
        screen.queryByRole('button', { name: en.environments.versions.installLts })
      ).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/install'))).toHaveLength(
        0
      );
    });

    it('falls back to the bare manager install when no Node recipe is offered', () => {
      render(<NodeVersionTable status={status} recipes={[NVM_INSTALL_RECIPE]} />);

      expect(screen.getByRole('button', { name: 'Install nvm' })).toBeInTheDocument();
    });

    it('states the blocker when nothing here installs the manager', () => {
      render(<NodeVersionTable status={status} recipes={[NODE_WITHOUT_NVM]} />);

      expect(screen.getByTestId('install-unresolved').textContent).toContain(
        'MangoStudio cannot install nvm on this machine'
      );
      expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
    });
  });
});
