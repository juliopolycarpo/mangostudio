/**
 * Everything the runner selector needs, assembled from app state.
 *
 * The selector itself is presentational so it can be tested against fixture
 * descriptors for all eight availability states. This is where the chat's
 * environment, its turns, the disclosure gate and the D14 fork live.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { needsExternalDisclosure } from '@mangostudio/shared/external-agents';
import { useState } from 'react';
import { RunnerSelector } from '@/components/layout/RunnerSelector';
import { useToast } from '@/components/ui/Toast';
import { ExternalDisclosureDialog } from '@/features/chat/components/ExternalDisclosureDialog';
import { useMessagesQuery } from '@/features/chat/queries';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { forkChatWithRunner } from '@/services/external-agent-service';
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

  const environmentName =
    environments.data?.find((environment) => environment.id === app.currentEnvironmentId)?.name ??
    app.currentEnvironmentId ??
    '';

  // D14 turns on whether the chat already carries turns, so a new, empty chat can
  // still be pointed at either kind without a fork.
  const hasTurns = messages.data?.pages.some((page) => page.messages.length > 0) === true;

  const activate = (descriptor: ExternalAgentDescriptor) => {
    app.setRunnerTarget(descriptor.targetId);
  };

  const fork = (runner: ChatRunnerConfiguration) => {
    if (!app.currentChatId) return;
    void forkChatWithRunner(app.currentChatId, runner)
      .then((chat) => app.handleSelectChat(chat.id))
      .catch(() => toast(t.externalAgents.selector.forkFailed, 'error'));
  };

  return (
    <>
      <RunnerSelector
        runner={app.runner}
        agents={app.agents}
        isAgentListLoading={app.isAgentListLoading}
        externalAgents={external.agents}
        environmentName={environmentName}
        hasTurns={hasTurns}
        disabled={app.isGenerating}
        onSelectAgent={app.setSelectedAgentId}
        onSelectExternal={(descriptor) => {
          // The disclosure is a Terms-of-Service obligation, so it gates the
          // first activation of a vendor rather than the first turn: the user
          // should see it before the chat is pointed at a third party, not
          // after.
          if (
            needsExternalDisclosure(
              disclosures.forTarget(descriptor.targetId),
              descriptor.capabilities
            )
          ) {
            setPendingDisclosure(descriptor);
            return;
          }
          activate(descriptor);
        }}
        onForkWithRunner={fork}
      />

      {pendingDisclosure ? (
        <ExternalDisclosureDialog
          descriptor={pendingDisclosure}
          onCancel={() => setPendingDisclosure(null)}
          onAccept={() => {
            const descriptor = pendingDisclosure;
            setPendingDisclosure(null);
            void disclosures.accept(descriptor.targetId, descriptor.capabilities);
            activate(descriptor);
          }}
        />
      ) : null}
    </>
  );
}
