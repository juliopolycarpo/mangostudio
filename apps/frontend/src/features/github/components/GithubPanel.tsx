import { useState } from 'react';
import { useGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import {
  type GithubPanelPrefs,
  readGithubPanelPrefs,
  writeGithubPanelPrefs,
} from '../lib/github-panel-prefs';
import { GithubInboxSection } from './GithubInboxSection';
import { GithubRepoSection } from './GithubRepoSection';

interface GithubPanelProps {
  readonly chatId: string;
  /** Null on a chat with no folder bound; the repository section says so. */
  readonly workdir: string | null;
}

/** The rail's testid for the panel as a whole. */
const GITHUB_PANEL_TESTID = 'github-panel';

/**
 * The GitHub rail panel: what is waiting on you, and what this repository looks
 * like right now.
 *
 * Two sections in that order on purpose. The inbox is about the person — a
 * review request does not stop mattering because you changed projects — so it
 * sits above the repository, which is about the folder. That ordering is also
 * why the panel is available on `chatId` alone while `git` needs a workdir: the
 * top half has nothing to do with a checkout, and gating the panel on one would
 * hide a full review queue from anybody whose chat has no folder yet.
 *
 * The panel never polls. Every list here is a live `gh` subprocess on whatever
 * machine the chat runs on, and a side panel left open in a background tab has
 * no business spawning one a minute forever. Each section carries a refresh and
 * reports its own staleness instead.
 *
 * @example
 * <GithubPanel chatId="chat-1" workdir="/srv/projects/mango" />
 */
export function GithubPanel({ chatId, workdir }: GithubPanelProps) {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<GithubPanelPrefs>(readGithubPanelPrefs);
  const gitState = useGitState(chatId);

  const updatePrefs = (next: GithubPanelPrefs) => {
    setPrefs(next);
    writeGithubPanelPrefs(next);
  };

  const branch = gitState.data?.state === 'repo' ? gitState.data.status.branch : null;

  return (
    // A `section` rather than a labelled `div`: the two sections inside are
    // each headed, so the panel is a real landmark a screen-reader user
    // navigates to, and `aria-label` is only supported on a role that takes it.
    <section
      data-testid={GITHUB_PANEL_TESTID}
      aria-label={t.github.title}
      className="app-scrollbar h-full min-h-0 divide-y divide-outline-variant/10 overflow-y-auto"
    >
      <GithubInboxSection
        chatId={chatId}
        collapsed={prefs.inboxCollapsed}
        onToggle={() => updatePrefs({ ...prefs, inboxCollapsed: !prefs.inboxCollapsed })}
      />
      <GithubRepoSection
        chatId={chatId}
        workdir={workdir}
        // No upstream is what makes the combined push-then-create action
        // mandatory rather than a convenience: `gh pr create` on an unpushed
        // branch prompts for where to push, and prompts are disabled.
        needsPush={Boolean(branch?.name) && !branch?.upstream}
        branchName={branch?.name ?? null}
        branchLoading={gitState.isLoading}
        prefs={prefs}
        onPrefsChange={updatePrefs}
      />
    </section>
  );
}
