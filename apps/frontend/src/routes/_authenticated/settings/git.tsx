import { createFileRoute } from '@tanstack/react-router';
import { GitSettingsPage } from '@/features/settings/git';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/settings/git')({
  component: GitSettingsRoute,
});

function GitSettingsRoute() {
  const app = useApp();

  return (
    <GitSettingsPage
      settings={app.settings.gitSettings}
      setSignCommits={app.settings.setSignCommits}
      setSignOff={app.settings.setSignOff}
      setPreferredCommitMessageModel={app.settings.setPreferredCommitMessageModel}
      setCommitMessageSystemPrompt={app.settings.setCommitMessageSystemPrompt}
      resetCommitMessageSystemPrompt={app.settings.resetCommitMessageSystemPrompt}
      setCommitMessageMaxDiffKb={app.settings.setCommitMessageMaxDiffKb}
    />
  );
}
