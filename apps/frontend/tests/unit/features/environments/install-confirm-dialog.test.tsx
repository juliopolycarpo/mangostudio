/**
 * InstallConfirmDialog: an uninstall step reads as removal — its own title,
 * a description naming what it deletes, and a "Remove" button — never the
 * "Run install" wording every other action keeps.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { InstallConfirmDialog } from '../../../../src/features/environments/components/InstallConfirmDialog';
import { render, screen } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

describe('InstallConfirmDialog', () => {
  it('words an uninstall step as removal, naming what it deletes', () => {
    const recipe = installRecipe({
      id: 'bun.uninstall',
      runtimeId: 'bun',
      action: 'uninstall',
      writes: ['$HOME/.bun'],
      argv: ['bash', '-c', 'rm -rf "$HOME/.bun"'],
    });

    render(
      <InstallConfirmDialog
        preparation={{ preparationId: 'prep-1', expiresAt: null, recipe }}
        steps={[{ recipe, input: { kind: 'none' } }]}
        isStarting={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(
      screen.getByRole('heading', {
        name: en.environments.install.confirmUninstallTitle.replace('{target}', 'Bun'),
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        en.environments.install.confirmUninstallDescription.replace('{paths}', '$HOME/.bun')
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: en.environments.install.runUninstall })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: en.environments.install.run })
    ).not.toBeInTheDocument();
  });

  it('keeps the ordinary install wording for a non-uninstall step', () => {
    const recipe = installRecipe();

    render(
      <InstallConfirmDialog
        preparation={{ preparationId: 'prep-1', expiresAt: null, recipe }}
        steps={[{ recipe, input: { kind: 'none' } }]}
        isStarting={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(
      screen.getByRole('heading', { name: en.environments.install.confirmTitle })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.environments.install.run })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: en.environments.install.runUninstall })
    ).not.toBeInTheDocument();
  });
});
