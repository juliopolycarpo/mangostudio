/**
 * The fallback when an install cannot be run for the user: the same command,
 * copyable, plus a plain sentence naming which guard refused it.
 *
 * The feature degrades to useful rather than disappearing — a user who cannot
 * click "Install" still learns exactly what to type.
 */

import type { InstallRecipePreview } from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { guardReasonLabel, runtimeNameList } from '../format';
import { useToolIdentities } from '../identity/use-tool-identities';
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
  const { copy, copied, failed: copyFailed } = useClipboard();
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
  // guard reason, an unsupported platform, or a missing requirement would
  // still refuse this recipe after the switch flips, and offering a fix that
  // does not fix anything is worse than not offering one.
  const canEnableInstalls =
    isLocal &&
    recipe.supported &&
    recipe.missingRequirements.length === 0 &&
    recipe.guard.reasons.length === 1 &&
    recipe.guard.reasons[0] === 'disabled';

  return (
    <div
      className="space-y-3 rounded-2xl border border-outline-variant/20 bg-surface-container-lowest/60 p-4"
      data-testid="copy-command-block"
    >
      <div className="space-y-1">
        <p className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">
          {s.guardBlockedTitle}
        </p>
        {reasons.map((reason) => (
          <p key={reason.key} className="text-sm text-on-surface-variant">
            {reason.text}
          </p>
        ))}
      </div>

      {canEnableInstalls && <EnableInstallsButton />}

      <p className="text-sm text-on-surface-variant/70">{s.copyCommandHint}</p>

      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl bg-surface-container-highest px-3 py-2 font-mono text-xs text-on-surface">
          {recipe.copyCommand}
        </code>
        <Button variant="secondary" size="sm" onClick={() => void copy(recipe.copyCommand)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t.environments.actions.copied : t.environments.actions.copy}
        </Button>
      </div>

      {copyFailed && <p className="text-xs text-error">{t.environments.actions.copyFailed}</p>}
    </div>
  );
}
