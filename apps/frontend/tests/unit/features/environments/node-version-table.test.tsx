/**
 * NodeVersionTable: every LTS status maps to its badge, and `unknown` stays
 * neutral without offering an upgrade.
 */

import type { LtsStatus, ManagedVersion } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { describe, expect, it } from 'vitest';
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
});
