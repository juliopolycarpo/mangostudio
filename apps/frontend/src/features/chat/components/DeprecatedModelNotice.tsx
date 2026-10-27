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
import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

import { ChatDockNotice } from './ChatPageNotices';

interface DeprecatedModelNoticeProps {
  readonly details: ModelUnavailableDetails;
  readonly isForking: boolean;
  readonly runnerAvailable: boolean;
  readonly onContinueWithRunner: (targetId: ExternalAgentTargetId) => void;
  readonly onDismiss: () => void;
}

export function DeprecatedModelNotice({
  details,
  isForking,
  runnerAvailable,
  onContinueWithRunner,
  onDismiss,
}: DeprecatedModelNoticeProps) {
  const { t } = useI18n();
  const labels = t.chat.deprecatedModel;
  const targetId = details.targetId;

  return (
    <ChatDockNotice>
      <Callout
        tone="warning"
        // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
        role="status"
        aria-live="polite"
        className="p-4"
        title={labels.title.replace('{provider}', details.provider ?? '')}
      >
        <div className="space-y-1">
          <p className="text-xs">{labels.body.replace('{model}', details.modelId ?? '')}</p>
          {targetId && !runnerAvailable ? (
            <p className="text-xs">{labels.runnerUnavailable.replace('{target}', targetId)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            {labels.dismiss}
          </Button>
          {targetId && runnerAvailable ? (
            <Button
              variant="primary"
              size="sm"
              loading={isForking}
              disabled={isForking}
              onClick={() => onContinueWithRunner(targetId)}
            >
              {labels.continueInNewChat.replace('{target}', targetId)}
              <ArrowRight size={ICON_SM} />
            </Button>
          ) : null}
        </div>
      </Callout>
    </ChatDockNotice>
  );
}
