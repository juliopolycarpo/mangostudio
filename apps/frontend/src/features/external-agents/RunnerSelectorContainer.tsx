/**
 * Everything the runner selector needs, assembled from app state.
 *
 * The selector itself is presentational so it can be tested against fixture
 * descriptors for all eight availability states. This is where the chat's
 * environment, its turns, the disclosure gate and the D14 fork live.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ExternalAgentDescriptor,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { normalizePermissionLevel } from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import { useState } from 'react';
import { RunnerSelector } from '@/components/layout/RunnerSelector';
import { useToast } from '@/components/ui/Toast';
import { ExternalDisclosureDialog } from '@/features/chat/components/ExternalDisclosureDialog';
import { useMessagesQuery } from '@/features/chat/queries';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { ApiError } from '@/lib/utils';
import { adoptExternalSession, forkChatWithRunner } from '@/services/external-agent-service';
import { ExternalSessionPicker } from './ExternalSessionPicker';
import { useExternalAgents } from './useExternalAgents';
import { useExternalDisclosures } from './useExternalDisclosures';

export function RunnerSelectorContainer() {
  const app = useApp();
  const { t } = useI18n();
  const { toast } = useToast();
  const environments = useEnvironmentEntitiesQuery();
  const external = useExternalAgents(app.currentEnvironmentId);
  const disclosures = useExternalDisclosures();
  const messages = useMessagesQuery(app.currentChatId);
  const [pendingDisclosure, setPendingDisclosure] = useState<ExternalAgentDescriptor | null>(null);
  const [isAccepting, setAccepting] = useState(false);
  const [isPickingSession, setPickingSession] = useState(false);
  const [adoptingId, setAdoptingId] = useState<string | undefined>(undefined);
  /** Bumped to make the picker re-list after an adoption the server refused as stale. */
  const [sessionReloadToken, setSessionReloadToken] = useState(0);

  const environment = environments.data?.find(
    (candidate) => candidate.id === app.currentEnvironmentId
  );
  const environmentName = environment?.name ?? app.currentEnvironmentId ?? '';

  // D14 turns on whether the chat already carries turns, so a new, empty chat can
  // still be pointed at either kind without a fork.
  //
  // An *unloaded* transcript is not an empty one. `useMessagesQuery` answers
  // `undefined` both for a chat with no turns and for one whose turns have not
  // arrived yet, and reading the second as the first would switch an existing
  // chat's runner kind in place — the one thing D14 exists to prevent, since the
  // transcript that survives the switch was produced by the other owner. So an
  // existing chat requires a fork until its transcript says otherwise. A chat
  // that has no id yet has no turns by construction, and its query never runs.
  const transcriptIsEmpty = messages.data?.pages.every((page) => page.messages.length === 0);
  const hasTurns = app.currentChatId ? transcriptIsEmpty !== true : false;

  const activate = (descriptor: ExternalAgentDescriptor) => {
    app.setRunnerTarget(descriptor.targetId);
  };

  const fork = (runner: ChatRunnerConfiguration) => {
    if (!app.currentChatId) return;
    void forkChatWithRunner(app.currentChatId, runner)
      .then((chat) => app.handleSelectChat(chat.id))
      .catch(() => toast(t.externalAgents.selector.forkFailed, 'error'));
  };

  /**
   * Adoption always lands in a new chat, so the only success path is navigating
   * to it. Every refusal keeps the picker open: the user is choosing between
   * rows, and closing the dialog under them would lose the choice they were
   * halfway through making.
   */
  const adopt = (session: ExternalNativeSession) => {
    const environmentId = app.currentEnvironmentId;
    if (!environmentId) return;
    setAdoptingId(session.nativeSessionId);
    void adoptExternalSession({ environmentId, session })
      .then((chat) => {
        setPickingSession(false);
        app.handleSelectChat(chat.id);
      })
      .catch((error: unknown) => {
        const code = error instanceof ApiError ? error.code : undefined;
        toast(adoptionMessage(code, t), 'error');
        // A stale row is the one failure the list itself can fix, so it
        // refreshes rather than leaving the same dead row to be clicked again.
        if (code === ERROR_CODES.CONFLICT) setSessionReloadToken((token) => token + 1);
      })
      .finally(() => setAdoptingId(undefined));
  };

  return (
    <>
      <RunnerSelector
        runner={app.runner}
        agents={app.agents}
        isAgentListLoading={app.isAgentListLoading}
        externalAgents={external.agents}
        isExternalAgentListLoading={external.isLoading}
        environmentName={environmentName}
        environmentTransportKind={environment?.transportKind}
        hasTurns={hasTurns}
        disabled={app.isGenerating}
        onSelectAgent={app.setSelectedAgentId}
        onSelectExternal={(descriptor) => {
          // The disclosure is a Terms-of-Service obligation, so it gates the
          // first activation of a vendor rather than the first turn: the user
          // should see it before the chat is pointed at a third party, not
          // after.
          // The server decides, and says so on the descriptor. A second rule
          // here could disagree with the one the turn-start refusal applies,
          // which is either a dialog that never satisfies the gate or an agent
          // the selector offers and every send refuses.
          if (descriptor.unavailableReason === 'disclosure-required') {
            setPendingDisclosure(descriptor);
            return;
          }
          activate(descriptor);
        }}
        onForkWithRunner={fork}
        onBrowseSessions={() => setPickingSession(true)}
      />

      {isPickingSession && app.currentEnvironmentId ? (
        <ExternalSessionPicker
          environmentId={app.currentEnvironmentId}
          environmentName={environmentName}
          {...(app.currentWorkdir ? { workspacePath: app.currentWorkdir } : {})}
          agents={external.agents}
          {...(adoptingId ? { adoptingId } : {})}
          reloadToken={sessionReloadToken}
          onAdopt={adopt}
          onClose={() => setPickingSession(false)}
        />
      ) : null}

      {pendingDisclosure ? (
        <ExternalDisclosureDialog
          targetId={pendingDisclosure.targetId}
          permissionLevel={normalizePermissionLevel(app.runnerPermissions.level).value}
          busy={isAccepting}
          onCancel={() => setPendingDisclosure(null)}
          onAccept={() => {
            // Persist first, activate second. The other order points the chat at
            // a third party on the strength of a write that can still fail, and
            // a failed one leaves the vendor already reachable with nothing on
            // record saying the user was ever shown the notice.
            const descriptor = pendingDisclosure;
            setAccepting(true);
            void disclosures
              .accept(descriptor.targetId, descriptor.environmentId)
              .then(() => {
                setPendingDisclosure(null);
                activate(descriptor);
              })
              .catch(() => {
                // The settings mutation raises its own toast. The dialog stays
                // open so the only way forward is still through the notice.
                toast(t.externalAgents.disclosure.acceptFailed, 'error');
              })
              .finally(() => setAccepting(false));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Which refusal the user is looking at.
 *
 * Each arm names a different next step — refresh the list, use the other chat,
 * pick a session that has a folder — so they are not collapsed into one
 * apology. Anything unrecognized falls back to the generic message rather than
 * to the server's own sentence: that text is written for an operator reading a
 * log, not for someone mid-click.
 */
function adoptionMessage(code: string | null | undefined, t: Messages): string {
  const labels = t.externalAgents.sessions;
  switch (code) {
    case ERROR_CODES.CONFLICT:
      return labels.staleSession;
    case ERROR_CODES.EXTERNAL_SESSION_HELD:
      return labels.heldSession;
    case ERROR_CODES.PERMISSION_DENIED:
      return labels.isolationUnproven;
    case ERROR_CODES.PROVIDER_ERROR:
      return labels.unreachable;
    default:
      return labels.adoptFailed;
  }
}
