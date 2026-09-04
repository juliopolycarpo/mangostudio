/**
 * RecipeAction: each lifecycle action's wording and weight, stated once.
 *
 * The cards assert *which* button appears; this asserts what each action looks
 * like, which is the part that used to be copy-pasted per call site.
 */

import { describe, expect, it } from 'bun:test';
import type { InstallRecipePreview } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { RecipeAction } from '../../../../src/features/environments/components/RecipeAction';
import { render, screen } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

function stepOf(recipe: InstallRecipePreview) {
  return { recipe, input: { kind: 'none' } as const };
}

describe('RecipeAction', () => {
  it('renders no control at all when the catalog offers no step', () => {
    const { container } = render(
      <RecipeAction step={undefined} action="install" catalog={[]} name="Bun" />
    );

    expect(container.querySelector('button')).toBeNull();
    expect(screen.queryByText(/Bun/)).not.toBeInTheDocument();
  });

  it('labels each action with the runtime it acts on', () => {
    const recipe = installRecipe({
      id: 'bun.install.official',
      runtimeId: 'bun',
      action: 'install',
    });

    render(<RecipeAction step={stepOf(recipe)} action="install" catalog={[recipe]} name="Bun" />);

    expect(
      screen.getByRole('button', {
        name: en.environments.runtimes.install.replace('{runtime}', 'Bun'),
      })
    ).toBeInTheDocument();
  });

  it('makes install the card call to action, and uninstall the quiet one', () => {
    const install = installRecipe({
      id: 'bun.install.official',
      runtimeId: 'bun',
      action: 'install',
    });
    const uninstall = installRecipe({ id: 'bun.uninstall', runtimeId: 'bun', action: 'uninstall' });

    const { container: installed } = render(
      <RecipeAction step={stepOf(install)} action="install" catalog={[install]} name="Bun" />
    );
    const { container: removed } = render(
      <RecipeAction step={stepOf(uninstall)} action="uninstall" catalog={[uninstall]} name="Bun" />
    );

    // The icon rides on install alone; an SVG is how it reaches the DOM.
    expect(installed.querySelector('svg')).not.toBeNull();
    expect(removed.querySelector('svg')).toBeNull();
    // Distinct classes are the observable half of the variant split — whatever
    // the design system names them, the two must not render identically.
    expect(installed.querySelector('button')?.className).not.toBe(
      removed.querySelector('button')?.className
    );
  });
});
