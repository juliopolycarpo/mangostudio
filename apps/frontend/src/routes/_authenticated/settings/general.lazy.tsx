import { createLazyFileRoute } from '@tanstack/react-router';
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/settings/general')({
  component: GeneralSettingsRoute,
});

function GeneralSettingsRoute() {
  const app = useApp();

  return (
    <GeneralSettings
      imageQuality={app.settings.globalImageQuality}
      setImageQuality={app.settings.setGlobalImageQuality}
      chatTitleSettings={app.settings.chatTitleSettings}
      availableTitleModels={app.catalog.textModels}
      setChatAutoRenameEnabled={app.settings.setChatAutoRenameEnabled}
      setChatTitleStrategy={app.settings.setChatTitleStrategy}
      setChatTitlePromptPrefixLength={app.settings.setChatTitlePromptPrefixLength}
      setPreferredChatTitleModel={app.settings.setPreferredChatTitleModel}
      multiAgentSettings={app.settings.multiAgentSettings}
      setMultiAgentEnabled={app.settings.setMultiAgentEnabled}
      setTraceVisibility={app.settings.setTraceVisibility}
      setMaxDelegationDepth={app.settings.setMaxDelegationDepth}
      setMaxSubagentCalls={app.settings.setMaxSubagentCalls}
      setSubagentTimeoutMs={app.settings.setSubagentTimeoutMs}
      setDefaultSubagentMaxTurns={app.settings.setDefaultSubagentMaxTurns}
      workspaceSettings={app.settings.workspaceSettings}
      setDefaultWorkdir={app.settings.setDefaultWorkdir}
      setRestrictToolsToWorkdir={app.settings.setRestrictToolsToWorkdir}
      setWorkspacePanelVisible={app.settings.setWorkspacePanelVisible}
      moveWorkspacePanel={app.settings.moveWorkspacePanel}
      setWorkspacePanelWidth={app.settings.setWorkspacePanelWidth}
      setChatSidebarWidth={app.settings.setChatSidebarWidth}
      addRecentWorkdir={app.settings.addRecentWorkdir}
    />
  );
}
