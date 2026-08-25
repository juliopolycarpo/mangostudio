/**
 * Prompt starters chosen from the workspace's own state — see
 * `lib/prompt-starters.ts` for the rules and why they degrade the way they do.
 *
 * These fill the composer rather than sending: a starter is the opening of a
 * sentence the user finishes, and a one-click send would spend a turn on a
 * prompt nobody read.
 */

import { MicroLabel } from '@/components/ui/MicroLabel';
import { useGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { type PromptStarterId, promptStarterIds, starterContext } from '../lib/prompt-starters';

interface SuggestedActionsProps {
  /** Null before the first chat exists; the generic starters cover that. */
  chatId: string | null;
  onSelect: (prompt: string) => void;
}

export function SuggestedActions({ chatId, onSelect }: SuggestedActionsProps) {
  const { t } = useI18n();
  const labels = t.home.starters;
  return (
    <section className="space-y-2">
      <MicroLabel as="h3">{labels.label}</MicroLabel>
      {chatId ? (
        <StarterButtons chatId={chatId} onSelect={onSelect} />
      ) : (
        <StarterList ids={promptStarterIds('none')} onSelect={onSelect} />
      )}
    </section>
  );
}

/**
 * Split so `useGitState` is only mounted for a chat that has an id — the hook
 * takes a `string`, and a chatless hub still deserves starters.
 */
function StarterButtons({ chatId, onSelect }: { chatId: string; onSelect: (p: string) => void }) {
  const gitState = useGitState(chatId);
  return <StarterList ids={promptStarterIds(starterContext(gitState.data))} onSelect={onSelect} />;
}

function StarterList({
  ids,
  onSelect,
}: {
  ids: readonly PromptStarterId[];
  onSelect: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const labels = t.home.starters;
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => {
        const text = labels[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(text)}
            className="rounded-xl border border-outline-variant/20 bg-surface-container-low/60 px-3.5 py-2 text-left text-sm text-on-surface-variant transition-colors hover:border-primary/30 hover:text-on-surface"
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
