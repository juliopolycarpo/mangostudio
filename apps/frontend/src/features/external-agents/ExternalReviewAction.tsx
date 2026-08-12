/**
 * "Review my changes" — the vendor's own review of the working tree.
 *
 * It lives in the repository panel, next to the changes it reviews, and
 * deliberately **not** next to the permissions dropdown: that control has an
 * "Auto-review" option which decides whether the agent answers its own
 * permission requests. Same word, opposite subject. Both this button's label
 * and its hint name what gets reviewed, so the two are never read as one
 * feature with a control in two places.
 *
 * Renders nothing at all unless the chat is run by an agent that reports
 * `nativeReview` on this machine — an absent action is a clearer answer than a
 * disabled one for something most runners simply do not have.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { Messages } from '@mangostudio/shared/i18n';
import { ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { ApiError, resolveApiErrorMessage } from '@/lib/utils';
import { useExternalAgents } from './useExternalAgents';

interface ExternalReviewActionProps {
  readonly chatId: string;
  /** False when the working tree is clean; the action stays visible and says why. */
  readonly hasChanges: boolean;
}

export function ExternalReviewAction({ chatId, hasChanges }: ExternalReviewActionProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const app = useApp();
  const labels = t.externalAgents.review;
  const [pending, setPending] = useState(false);
  const targetId = app.runner.kind === 'external' ? app.runner.targetId : null;
  const external = useExternalAgents(app.currentEnvironmentId);
  const descriptor = targetId ? external.find(targetId) : undefined;

  // The chat in the rail is the chat the turn would run on. Guarding on it
  // keeps the button from starting a review in whichever chat the composer
  // happens to be pointed at after a fast switch.
  if (!targetId || app.currentChatId !== chatId) return null;
  if (!descriptor?.capabilities.nativeReview) return null;

  const startReview = async () => {
    setPending(true);
    try {
      await app.handleReviewChanges();
    } catch (error) {
      toast(reviewFailureMessage(error, labels), 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-xl border border-outline-variant/15 bg-surface-container/35 p-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-full"
        disabled={!hasChanges || pending || app.isGenerating}
        loading={pending}
        onClick={() => void startReview()}
      >
        <ScanSearch size={14} aria-hidden="true" />
        {pending ? labels.running : labels.button}
      </Button>
      <p className="text-[11px] leading-4 text-on-surface-variant">
        {hasChanges
          ? labels.hint.replace('{vendor}', t.externalAgents.target[targetId])
          : labels.noChanges}
      </p>
    </div>
  );
}

/**
 * The refusal in the reader's own language, where the server has one to give.
 *
 * The transcript already carries the server's own sentence — this is the copy
 * for the panel the user clicked in, and every case it names is one the server
 * decided rather than one this component guessed. Anything else falls back to
 * the server's message, and only then to a neutral failure.
 */
function reviewFailureMessage(
  error: unknown,
  labels: Messages['externalAgents']['review']
): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === ERROR_CODES.EXTERNAL_REVIEW_REQUIRES_GIT) return labels.requiresGit;
  if (code === ERROR_CODES.UNSUPPORTED) return labels.unsupported;
  // The stream's only other validation refusal for a chat this action rendered
  // for: it is external by construction, so what is missing is the folder.
  if (code === ERROR_CODES.VALIDATION) return labels.requiresWorkdir;
  return resolveApiErrorMessage(error, labels.failed);
}
