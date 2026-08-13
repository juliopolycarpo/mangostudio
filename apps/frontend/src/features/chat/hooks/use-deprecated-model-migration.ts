/**
 * The one action a deprecated-model refusal offers: continue in a new chat
 * under the vendor's own CLI.
 *
 * A fork, not an edit — see `DeprecatedModelNotice` for why. This lives in its
 * own hook because the notice is presentational and the migration needs the
 * router: a fork that did not navigate would leave the user looking at the chat
 * that just refused them, with the new one only findable in the sidebar.
 */

import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { useCallback, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { forkChatWithRunner } from '@/services/external-agent-service';

export function useDeprecatedModelMigration(
  chatId: string | null,
  canForkTarget: (targetId: ExternalAgentTargetId) => boolean = () => true
) {
  const app = useApp();
  const { t } = useI18n();
  const { toast } = useToast();
  const [isForking, setForking] = useState(false);

  const continueWithRunner = useCallback(
    (targetId: ExternalAgentTargetId) => {
      if (!chatId || isForking || !canForkTarget(targetId)) return;
      setForking(true);
      void forkChatWithRunner(chatId, { kind: 'external', targetId })
        .then((chat) => app.handleSelectChat(chat.id))
        .catch(() => toast(t.chat.deprecatedModel.forkFailed, 'error'))
        .finally(() => setForking(false));
    },
    [app, canForkTarget, chatId, isForking, t.chat.deprecatedModel.forkFailed, toast]
  );

  return { isForking, continueWithRunner };
}
