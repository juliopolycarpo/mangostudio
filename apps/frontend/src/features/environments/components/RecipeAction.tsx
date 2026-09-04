/**
 * One runtime lifecycle button — install, update, or uninstall — with the
 * wording and weight each of the three always carries.
 *
 * Every card offering these was spelling out the same `InstallAction` call per
 * action, so the primary/ghost split and the "Install {runtime}" label were
 * restated at each site. Here the action names its own presentation, and a
 * card only has to answer which step (if any) it has.
 */

import type { InstallRecipePreview } from '@mangostudio/shared/environments';
import { Download } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import type { InstallChainStep } from '../install-chain';
import { InstallAction } from './InstallAction';

/** Install is the card's call to action; update is ordinary; uninstall is deliberately quiet. */
const ACTION_PRESENTATION = {
  install: { variant: 'primary', icon: <Download size={14} /> },
  update: {},
  uninstall: { variant: 'ghost' },
} as const satisfies Record<string, { variant?: 'primary' | 'ghost'; icon?: React.ReactNode }>;

export interface RecipeActionProps {
  /** The recipe and its input, or undefined when the catalog offers none — the card then shows no button. */
  readonly step: InstallChainStep | undefined;
  readonly action: keyof typeof ACTION_PRESENTATION;
  /** Every recipe on offer here; `InstallAction` needs it to resolve a chain. */
  readonly catalog: readonly InstallRecipePreview[];
  /** Display name of the runtime or agent, as it appears in the label. */
  readonly name: string;
  readonly environmentId?: string;
  /** Steps that finish what this action promised, e.g. "make it the default". */
  readonly followUpSteps?: readonly InstallChainStep[];
}

export function RecipeAction({
  step,
  action,
  catalog,
  name,
  environmentId,
  followUpSteps,
}: RecipeActionProps) {
  const { t } = useI18n();
  if (!step) return null;

  return (
    <InstallAction
      recipe={step.recipe}
      input={step.input}
      catalog={catalog}
      label={formatMessage(t.environments.runtimes[action], { runtime: name })}
      {...ACTION_PRESENTATION[action]}
      {...(followUpSteps?.length ? { followUpSteps } : {})}
      environmentId={environmentId}
    />
  );
}
