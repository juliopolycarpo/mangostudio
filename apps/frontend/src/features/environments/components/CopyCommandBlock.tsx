/**
 * The fallback when an install cannot be run for the user: the same command,
 * copyable, plus a plain sentence naming which guard refused it.
 *
 * The feature degrades to useful rather than disappearing — a user who cannot
 * click "Install" still learns exactly what to type.
 */

import type { InstallRecipePreview } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';

import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

import { guardReasonLabel, runtimeNameList } from '../format';
import { useToolIdentities } from '../identity/use-tool-identities';
import { CopyLine } from './CopyLine';
import { EnableInstallsButton } from './EnableInstallsButton';

interface CopyCommandBlockProps {
  recipe: InstallRecipePreview;
  /** Server-sent explanation, used only when no guard reason applies. */
  message?: string;
  /**
   * Which machine this recipe is about; omitted means the hub's own, same
   * convention as `InstallAction`. Decides whether the one-click "Enable
   * installs" affordance below can even apply — flipping this hub's own
   * switch says nothing about a remote environment's `allowInstalls`.
   */
  environmentId?: string;
}

export function CopyCommandBlock({ recipe, message, environmentId }: CopyCommandBlockProps) {
  const { t } = useI18n();
  const s = t.environments.install;
  const { resolve } = useToolIdentities();

  // Each blocker keeps a key naming where it came from, so two guards that
  // happen to render the same sentence stay two lines.
  const reasons: { key: string; text: string }[] = recipe.guard.reasons.map((reason) => ({
    key: `guard:${reason}`,
    text: guardReasonLabel(t, reason),
  }));
  // Every blocker is stated: a guard refusal does not make an unsupported
  // platform stop being the other reason this cannot run here.
  if (!recipe.supported) reasons.push({ key: 'unsupported', text: s.unsupported });
  if (recipe.missingRequirements.length > 0) {
    reasons.push({
      key: 'missing-requirements',
      text: formatMessage(s.missingRequirements, {
        requirements: runtimeNameList(resolve, recipe.missingRequirements),
      }),
    });
  }
  if (reasons.length === 0 && message) reasons.push({ key: 'message', text: message });

  const isLocal = environmentId === undefined || environmentId === LOCAL_ENVIRONMENT_ID;
  // Offered only when the global switch is the *entire* problem: any other
  // guard reason, an unsupported platform, a missing requirement, or a recipe
  // MangoStudio never runs at all would still refuse this after the switch
  // flips, and offering a fix that does not fix anything is worse than not
  // offering one.
  const canEnableInstalls =
    isLocal &&
    recipe.runnable &&
    recipe.supported &&
    recipe.missingRequirements.length === 0 &&
    recipe.guard.reasons.length === 1 &&
    recipe.guard.reasons[0] === 'disabled';

  return (
    <div className="space-y-3" data-testid="copy-command-block">
      <Callout tone="warning" title={s.guardBlockedTitle}>
        <div className="space-y-1">
          {reasons.map((reason) => (
            <p key={reason.key}>{reason.text}</p>
          ))}
        </div>
      </Callout>

      {canEnableInstalls && <EnableInstallsButton />}

      <p className="text-sm text-fg-muted">{s.copyCommandHint}</p>

      <CopyLine value={recipe.copyCommand} />
    </div>
  );
}
