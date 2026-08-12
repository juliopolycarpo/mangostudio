/**
 * The refusal a chat gets when its stored model belongs to a provider
 * MangoStudio no longer owns.
 *
 * The one action here is a fork, never an edit. A chat with MangoStudio-owned
 * turns cannot become vendor-owned in place — the transcript that survives the
 * switch was produced by the other owner, and replaying it to the vendor as its
 * own prior output is the bug D14 exists to prevent. So the offer is a new chat
 * carrying environment and workdir, and the copy says so.
 *
 * Picking a different model deliberately has no button: the model selector is
 * already in the composer directly below this notice, and a second control for
 * it would be a second place model selection lives.
 */

import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import type { ModelUnavailableDetails } from '@mangostudio/shared/generation';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface DeprecatedModelNoticeProps {
  readonly details: ModelUnavailableDetails;
  readonly isForking: boolean;
  readonly onContinueWithRunner: (targetId: ExternalAgentTargetId) => void;
  readonly onDismiss: () => void;
}

export function DeprecatedModelNotice({
  details,
  isForking,
  onContinueWithRunner,
  onDismiss,
}: DeprecatedModelNoticeProps) {
  const { t } = useI18n();
  const labels = t.chat.deprecatedModel;
  const targetId = details.targetId;

  return (
    <div className="px-6 pt-4">
      <div className="mx-auto max-w-4xl">
        <div
          className="flex flex-col gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 sm:flex-row sm:items-start sm:justify-between"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-amber-200" />
            <div className="space-y-1">
              <p className="text-sm font-bold text-on-surface">
                {labels.title.replace('{provider}', details.provider ?? '')}
              </p>
              <p className="text-xs leading-relaxed text-on-surface-variant/75">
                {labels.body.replace('{model}', details.modelId ?? '')}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
            <Button variant="secondary" size="sm" onClick={onDismiss}>
              {labels.dismiss}
            </Button>
            {targetId ? (
              <Button
                variant="primary"
                size="sm"
                loading={isForking}
                disabled={isForking}
                onClick={() => onContinueWithRunner(targetId)}
              >
                {labels.continueInNewChat.replace('{target}', targetId)}
                <ArrowRight size={14} />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
