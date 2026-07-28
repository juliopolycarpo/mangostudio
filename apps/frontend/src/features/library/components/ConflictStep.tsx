/**
 * Step 1 — settle every divergent resource.
 *
 * There is no default selection and no way past this step while anything is
 * unresolved. 009 rejects an apply that does not name a winner, and a form that
 * lets someone walk into that error has failed at the one thing it is for.
 *
 * "Keep them different" is a real answer, not a dismissal: sometimes copies
 * *should* differ, and saying so is an outcome the system records.
 */

import type { PropagationPreview, PropagationPreviewEntry } from '@mangostudio/shared/library';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatBytes, formatRelativeTime } from '../format';
import { resolutionFor, type WizardDraft } from '../propagation';
import { ContentGroupList } from './ContentGroupList';

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

  if (divergent.length === 0) {
    return (
      <p className="text-on-surface-variant text-sm" data-testid="conflict-none">
        {l.conflict.description}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="conflict-step">
      <div className="space-y-1">
        <p className="text-on-surface text-sm">{l.conflict.description}</p>
        {unresolved.length > 0 && (
          <p className="text-error text-xs" data-testid="unresolved-count">
            {formatMessage(l.conflict.unresolved, { count: String(unresolved.length) })}
          </p>
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
  const { t, locale } = useI18n();
  const l = t.library;
  const choice = resolutionFor(draft, entry.resourceKey);

  return (
    <section
      className="space-y-3 rounded-xl border border-outline-variant/15 bg-surface-container p-3"
      data-testid="conflict-entry"
      data-resource-key={entry.resourceKey}
      data-resolved={resolved}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-on-surface text-sm">{entry.ref.slug}</h3>
        {resolved && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            {l.conflict.resolved}
          </span>
        )}
      </header>

      <ContentGroupList
        groups={entry.sourceGroups}
        selectedHash={choice.resolution === 'adopt-group' ? choice.winnerContentHash : undefined}
        onSelect={(contentHash) =>
          onResolve(entry.resourceKey, 'adopt-group', { winnerContentHash: contentHash })
        }
        renderMeta={(group) =>
          [
            formatMessage(l.detail.copies, { count: String(group.instanceCount) }),
            formatMessage(l.detail.modified, {
              when: formatRelativeTime(group.newestModifiedAtMs, locale),
            }),
            formatBytes(group.sizeBytes),
          ].join(' · ')
        }
      />

      {/*
        Presented as a peer of the version choices, not as a way out of making
        one. The explanation matters: the divergence stops being flagged until
        one of the contents changes again, which is a commitment, not a snooze.
      */}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-outline-variant/15 bg-surface-container-high p-2.5">
        <input
          type="radio"
          name={`resolution:${entry.resourceKey}`}
          checked={choice.resolution === 'keep-per-location'}
          onChange={() => onResolve(entry.resourceKey, 'keep-per-location')}
          data-testid="keep-per-location"
          className="mt-0.5 size-3.5 accent-primary"
        />
        <span className="min-w-0">
          <span className="block font-medium text-on-surface text-xs">
            {l.conflict.keepPerLocation.title}
          </span>
          <span className="block text-[11px] text-on-surface-variant/70">
            {l.conflict.keepPerLocation.description}
          </span>
        </span>
      </label>

      <EditOption entry={entry} draft={draft} onResolve={onResolve} />
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
      <p className="text-[11px] text-on-surface-variant/60" data-testid="edit-unavailable">
        {l.conflict.edit.unavailable}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="radio"
          name={`resolution:${entry.resourceKey}`}
          checked={editing}
          onChange={() =>
            onResolve(entry.resourceKey, 'edit-then-adopt', {
              editedContent: choice.editedContent ?? '',
            })
          }
          data-testid="edit-then-adopt"
          className="mt-0.5 size-3.5 accent-primary"
        />
        <span className="min-w-0">
          <span className="block font-medium text-on-surface text-xs">{l.conflict.edit.title}</span>
          <span className="block text-[11px] text-on-surface-variant/70">
            {l.conflict.edit.description}
          </span>
        </span>
      </label>
      {editing && (
        <>
          <textarea
            value={choice.editedContent ?? ''}
            onChange={(event) =>
              onResolve(entry.resourceKey, 'edit-then-adopt', {
                editedContent: event.target.value,
              })
            }
            placeholder={l.conflict.edit.placeholder}
            aria-label={l.conflict.edit.placeholder}
            rows={8}
            className="app-scrollbar w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-2 font-mono text-[11px] text-on-surface outline-none focus:border-primary"
          />
          {(choice.editedContent ?? '').trim().length === 0 && (
            <p className="text-error text-[11px]">{l.conflict.edit.empty}</p>
          )}
        </>
      )}
    </div>
  );
}
