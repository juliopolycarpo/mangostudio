/**
 * `prerequisite-missing` findings for a runtime this machine could never
 * install, because every recipe that would install it needs something this
 * platform has no recipe for either — `winget` on a Linux hub, most of all.
 *
 * Hub-side rather than runtime-side: the runtime reports what it found on
 * disk and has no idea the recipe table exists. Pure and synchronous so it is
 * cheap to compute on every probe and cheap to test in isolation; the caller
 * in `probing-service.ts` is the one place that decides *when* it has enough
 * of the batch to call this at all.
 */

import type { RuntimeFinding, RuntimeId, RuntimeStatus } from '@mangostudio/shared/environments';
import { hasInstallRecipeForRuntime, type InstallRecipe } from './install-recipes';

/**
 * `winget` is the one requirement in today's table with no install recipe
 * anywhere — it comes from the Microsoft Store, never from MangoStudio — so
 * it is the only requirement with a remedy of its own. Every other
 * requirement that could reach {@link remedyFor} already has an install
 * recipe on some platform, which is what keeps it out of a
 * `prerequisite-missing` finding in the first place; the empty-string branch
 * covers a future requirement that might not.
 *
 * The URL alone, with no sentence around it. A remedy is interpolated into a
 * localized finding message, so prose written here would reach a pt-BR reader
 * in English — and `FindingList` only turns a remedy into a followable link
 * when the whole value is one.
 */
const WINGET_REMEDY = 'https://apps.microsoft.com/detail/9nblggh4nns1';

function remedyFor(requirement: RuntimeId): string {
  return requirement === 'winget' ? WINGET_REMEDY : '';
}

/** Not currently installed, and no recipe — for any runtime, any action — would ever put it there. */
function isUnfixableMissing(
  requirement: RuntimeId,
  installedIds: ReadonlySet<RuntimeId>,
  platform: string
): boolean {
  return !installedIds.has(requirement) && !hasInstallRecipeForRuntime(requirement, platform);
}

/** The `install`-action recipes that would put `runtimeId` on this machine for the first time. */
function installRecipesFor(
  runtimeId: RuntimeId,
  platform: string,
  recipes: readonly InstallRecipe[]
): InstallRecipe[] {
  return recipes.filter(
    (recipe) =>
      recipe.runtimeId === runtimeId &&
      recipe.action === 'install' &&
      recipe.platforms.includes(platform as InstallRecipe['platforms'][number])
  );
}

/**
 * `prerequisite-missing` findings for every runtime in `statuses` that has no
 * installations and whose every `install`-action recipe on `platform` needs
 * something unfixable. A runtime with even one recipe that could still work —
 * a satisfied requirement, or one this machine could still install — gets no
 * finding: one working path is one way forward, and a warning beside it would
 * say "you cannot" about something you still can.
 *
 * Takes the whole probe batch rather than one status at a time: "is
 * `winget` installed" about node's requirement can only be answered by
 * having winget's own status in hand, and a status naming a *different*
 * runtime is not "a runtime status" on its own.
 * // Usage: computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES)
 */
export function computePrerequisiteMissingFindings(
  statuses: readonly RuntimeStatus[],
  platform: string,
  recipes: readonly InstallRecipe[]
): ReadonlyMap<RuntimeId, readonly RuntimeFinding[]> {
  const installedIds = new Set<RuntimeId>(
    statuses.filter((status) => status.installations.length > 0).map((status) => status.id)
  );

  const result = new Map<RuntimeId, readonly RuntimeFinding[]>();
  for (const status of statuses) {
    if (status.installations.length > 0) continue;

    const installRecipes = installRecipesFor(status.id, platform, recipes);
    if (installRecipes.length === 0) continue;

    const blocked = (recipe: InstallRecipe) =>
      recipe.requires.some((requirement) =>
        isUnfixableMissing(requirement, installedIds, platform)
      );
    if (!installRecipes.every(blocked)) continue;

    const findings: RuntimeFinding[] = [];
    for (const recipe of installRecipes) {
      for (const requirement of recipe.requires) {
        if (!isUnfixableMissing(requirement, installedIds, platform)) continue;
        findings.push({
          code: 'prerequisite-missing',
          params: { recipe: recipe.id, requirement, remedy: remedyFor(requirement) },
          severity: 'warn',
        });
      }
    }
    result.set(status.id, findings);
  }

  return result;
}
