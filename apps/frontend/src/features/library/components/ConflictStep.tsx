/**
 * Step 1 — settle every divergent resource.
 *
 * There is no default selection and no way past this step while anything is
 * unresolved. 009 rejects an apply that does not name a winner, and a form that
 * lets someone walk into that error has failed at the one thing it is for.
 *
 * "Keep them different" is a real answer, not a dismissal: sometimes copies
 * *should* differ, and saying so is an outcome the system records.
 *
 * The wizard only stops here when something diverges. With one readable version
 * of everything there is nothing to choose, and a step that says so is a screen
 * the person has to click through for nothing.
 */

import type { PropagationPreview, PropagationPreviewEntry } from '@mangostudio/shared/library';

import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

import { resolutionFor, type WizardDraft } from '../propagation';
import { ChoiceRow } from './ChoiceRow';
import { ContentGroupList } from './ContentGroupList';
import { InlineNote } from './InlineNote';

interface ConflictStepProps {
  readonly preview: PropagationPreview;
  readonly draft: WizardDraft;
  readonly unresolved: readonly PropagationPreviewEntry[];
  readonly onResolve: (
    resourceKey: string,
    resolution: 'adopt-group' | 'keep-per-location' | 'edit-then-adopt',
    detail?: { winnerContentHash?: string; editedContent?: string }
  ) => void;
}

export function ConflictStep({ preview, draft, unresolved, onResolve }: ConflictStepProps) {
  const { t } = useI18n();
  const l = t.library;
  const divergent = preview.entries.filter((entry) => entry.requiresWinnerSelection);

  return (
    <div className="space-y-4" data-testid="conflict-step">
      <div className="space-y-2">
        <p className="text-fg-muted text-sm">{l.conflict.description}</p>
        {unresolved.length > 0 && (
          <InlineNote tone="warning" data-testid="unresolved-count">
            {formatMessage(l.conflict.unresolved, { count: String(unresolved.length) })}
          </InlineNote>
        )}
      </div>

      {divergent.map((entry) => (
        <ConflictEntry
          key={entry.resourceKey}
          entry={entry}
          draft={draft}
          onResolve={onResolve}
          resolved={!unresolved.some((pending) => pending.resourceKey === entry.resourceKey)}
        />
      ))}
    </div>
  );
}

function ConflictEntry({
  entry,
  draft,
  resolved,
  onResolve,
}: {
  readonly entry: PropagationPreviewEntry;
  readonly draft: WizardDraft;
  readonly resolved: boolean;
  readonly onResolve: ConflictStepProps['onResolve'];
}) {
  const { t } = useI18n();
  const l = t.library;
  const choice = resolutionFor(draft, entry.resourceKey);

  return (
    <section
      className="space-y-3 rounded-md border border-stroke bg-surface p-4"
      data-testid="conflict-entry"
      data-resource-key={entry.resourceKey}
      data-resolved={resolved}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-fg text-sm">{entry.ref.slug}</h3>
        {resolved && <Badge variant="success">{l.conflict.resolved}</Badge>}
      </header>

      <div className="space-y-1">
        <ContentGroupList
          groups={entry.sourceGroups}
          selectedHash={choice.resolution === 'adopt-group' ? choice.winnerContentHash : undefined}
          onSelect={(contentHash) =>
            onResolve(entry.resourceKey, 'adopt-group', { winnerContentHash: contentHash })
          }
        />

        {/*
          Presented as a peer of the version choices, not as a way out of making
          one. The explanation matters: the divergence stops being flagged until
          one of the contents changes again, which is a commitment, not a snooze.
        */}
        <ChoiceRow
          control="radio"
          name={`resolution:${entry.resourceKey}`}
          checked={choice.resolution === 'keep-per-location'}
          onChange={() => onResolve(entry.resourceKey, 'keep-per-location')}
          data-testid="keep-per-location"
        >
          <span className="block font-medium text-fg text-sm">
            {l.conflict.keepPerLocation.title}
          </span>
          <span className="block text-fg-muted text-xs">
            {l.conflict.keepPerLocation.description}
          </span>
        </ChoiceRow>

        <EditOption entry={entry} draft={draft} onResolve={onResolve} />
      </div>
    </section>
  );
}

/**
 * Hand-merging a third version. Unavailable for skills: a skill is a directory
 * and there is no single text to edit, which the apply route also refuses.
 */
function EditOption({
  entry,
  draft,
  onResolve,
}: {
  readonly entry: PropagationPreviewEntry;
  readonly draft: WizardDraft;
  readonly onResolve: ConflictStepProps['onResolve'];
}) {
  const { t } = useI18n();
  const l = t.library;
  const choice = resolutionFor(draft, entry.resourceKey);
  const editing = choice.resolution === 'edit-then-adopt';

  if (entry.ref.kind === 'skill') {
    return (
      <InlineNote tone="info" className="px-3 py-1" data-testid="edit-unavailable">
        {l.conflict.edit.unavailable}
      </InlineNote>
    );
  }

  return (
    <>
      <ChoiceRow
        control="radio"
        name={`resolution:${entry.resourceKey}`}
        checked={editing}
        onChange={() =>
          onResolve(entry.resourceKey, 'edit-then-adopt', {
            editedContent: choice.editedContent ?? '',
          })
        }
        data-testid="edit-then-adopt"
      >
        <span className="block font-medium text-fg text-sm">{l.conflict.edit.title}</span>
        <span className="block text-fg-muted text-xs">{l.conflict.edit.description}</span>
      </ChoiceRow>
      {editing && (
        <div className="space-y-2 px-3 pt-1 pb-2">
          <Textarea
            value={choice.editedContent ?? ''}
            onChange={(event) =>
              onResolve(entry.resourceKey, 'edit-then-adopt', {
                editedContent: event.target.value,
              })
            }
            placeholder={l.conflict.edit.placeholder}
            aria-label={l.conflict.edit.placeholder}
            rows={8}
            className="app-scrollbar font-mono text-xs"
          />
          {(choice.editedContent ?? '').trim().length === 0 && (
            <InlineNote tone="warning">{l.conflict.edit.empty}</InlineNote>
          )}
        </div>
      )}
    </>
  );
}
