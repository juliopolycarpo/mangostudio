/**
 * Turns "install Node" into the ordered list of installs that actually gets
 * there.
 *
 * `installable` on a status means a recipe exists for that runtime on this
 * platform — not that the recipe can run. On a machine without nvm the only
 * Node recipes both require nvm, so acting on the flag alone earns a 409. The
 * preview payload already carries `missingRequirements`, and every recipe the
 * catalog offers is a candidate for satisfying one, so the path out is a chain
 * resolved here rather than a second derived flag on the wire.
 */

import type {
  InstallRecipeId,
  InstallRecipePreview,
  RecipeInput,
  RuntimeId,
} from '@mangostudio/shared/environments';

export interface InstallChainStep {
  readonly recipe: InstallRecipePreview;
  readonly input: RecipeInput;
}

export type InstallChain =
  /** Every prerequisite resolved. Run in order; the target is the last step. */
  | { readonly kind: 'ready'; readonly steps: readonly InstallChainStep[] }
  /** Nothing on offer installs these here, so no affordance could succeed. */
  | { readonly kind: 'unresolved'; readonly missing: readonly RuntimeId[] };

/**
 * A prerequisite has to be runnable unattended: the chain confirms once and
 * then runs every step, so a recipe that would need its own input from the
 * user is no more usable here than a missing one.
 */
function findPrerequisite(
  catalog: readonly InstallRecipePreview[],
  requirement: RuntimeId
): InstallRecipePreview | undefined {
  return catalog.find(
    (candidate) =>
      candidate.runtimeId === requirement &&
      candidate.action === 'install' &&
      candidate.inputKind === 'none' &&
      candidate.supported
  );
}

/**
 * The chain that installs `target`, prerequisites first.
 *
 * Guards are not consulted: they are a property of the machine rather than of
 * one recipe, so a blocked guard blocks the whole chain and is reported where
 * it already was — on the target.
 */
export function resolveInstallChain(
  catalog: readonly InstallRecipePreview[],
  target: InstallRecipePreview,
  input: RecipeInput
): InstallChain {
  const steps: InstallChainStep[] = [];
  const missing: RuntimeId[] = [];
  const placed = new Set<InstallRecipeId>();

  const visit = (
    recipe: InstallRecipePreview,
    recipeInput: RecipeInput,
    pending: ReadonlySet<InstallRecipeId>
  ): void => {
    if (placed.has(recipe.id)) return;
    const nextPending = new Set(pending).add(recipe.id);

    for (const requirement of recipe.missingRequirements) {
      const prerequisite = findPrerequisite(catalog, requirement);
      // A requirement nothing here installs, and one whose recipe is already
      // being visited, are both dead ends rather than steps. Reporting the
      // cycle as unresolved keeps a malformed catalog from hanging the walk.
      if (!prerequisite || nextPending.has(prerequisite.id)) {
        if (!missing.includes(requirement)) missing.push(requirement);
        continue;
      }
      visit(prerequisite, { kind: 'none' }, nextPending);
    }

    placed.add(recipe.id);
    steps.push({ recipe, input: recipeInput });
  };

  visit(target, input, new Set());

  return missing.length > 0 ? { kind: 'unresolved', missing } : { kind: 'ready', steps };
}
