/**
 * Step 3 — every operation, grouped, before anything is written.
 *
 * Two rules drive the layout. An `overwrite` shows a diff of what it replaces,
 * because overwriting is the destructive operation and it never lands unseen.
 * And `noop` is *shown*, collapsed — "already in sync" is a result the user
 * asked for, not an absence worth hiding.
 */

import type {
  AdapterStrategy,
  LibraryLocationId,
  PropagationOperation,
  PropagationPreview,
} from '@mangostudio/shared/library';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { hashPrefix } from '../format';
import {
  applySummary,
  effectiveStrategy,
  operationKey,
  type PlannedWrite,
  plannedWrites,
  resolutionFor,
  type WizardDraft,
} from '../propagation';
import { AdaptationNotes } from './AdaptationNotes';
import { BlockedReason } from './BlockedReason';
import { InstanceDiff } from './InstanceDiff';

interface ReviewStepProps {
  readonly preview: PropagationPreview;
  readonly draft: WizardDraft;
  readonly onSelectStrategy: (
    resourceKey: string,
    locationId: LibraryLocationId,
    strategy: AdapterStrategy
  ) => void;
  readonly onToggleAcknowledged: (resourceKey: string, locationId: LibraryLocationId) => void;
}

type ReviewGroup = 'create' | 'overwrite' | 'adapt' | 'noop' | 'blocked';

const GROUP_OF: Readonly<Record<PropagationOperation, ReviewGroup>> = {
  create: 'create',
  overwrite: 'overwrite',
  'adapt-create': 'adapt',
  'adapt-overwrite': 'adapt',
  noop: 'noop',
  blocked: 'blocked',
};

const GROUP_ORDER: readonly ReviewGroup[] = ['overwrite', 'adapt', 'create', 'blocked', 'noop'];

export function ReviewStep({
  preview,
  draft,
  onSelectStrategy,
  onToggleAcknowledged,
}: ReviewStepProps) {
  const { t } = useI18n();
  const l = t.library;
  const writes = plannedWrites(preview, draft);
  const summary = applySummary(writes);

  const groupLabels: Record<ReviewGroup, string> = {
    create: l.review.groupCreate,
    overwrite: l.review.groupOverwrite,
    adapt: l.review.groupAdapt,
    noop: l.review.groupNoop,
    blocked: l.review.groupBlocked,
  };

  const kept = preview.entries.filter(
    (entry) => resolutionFor(draft, entry.resourceKey).resolution === 'keep-per-location'
  );

  return (
    <div className="space-y-4" data-testid="review-step">
      <p className="text-on-surface text-sm" data-testid="review-summary">
        {formatMessage(l.review.summary, {
          files: String(summary.writes),
          backups: String(summary.backups),
        })}
      </p>

      {GROUP_ORDER.map((group) => {
        const rows = writes.filter((write) => GROUP_OF[write.operation] === group);
        if (rows.length === 0) return null;
        return (
          <ReviewGroupSection
            key={group}
            group={group}
            label={groupLabels[group]}
            rows={rows}
            preview={preview}
            draft={draft}
            onSelectStrategy={onSelectStrategy}
            onToggleAcknowledged={onToggleAcknowledged}
          />
        );
      })}

      {kept.length > 0 && (
        <section className="space-y-1" data-testid="review-kept">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.skipReason['divergence-acknowledged']}
          </h3>
          <ul className="space-y-0.5">
            {kept.map((entry) => (
              <li key={entry.resourceKey} className="text-on-surface-variant text-xs">
                {entry.ref.slug}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReviewGroupSection({
  group,
  label,
  rows,
  preview,
  draft,
  onSelectStrategy,
  onToggleAcknowledged,
}: {
  readonly group: ReviewGroup;
  readonly label: string;
  readonly rows: readonly PlannedWrite[];
  readonly preview: PropagationPreview;
  readonly draft: WizardDraft;
  readonly onSelectStrategy: ReviewStepProps['onSelectStrategy'];
  readonly onToggleAcknowledged: ReviewStepProps['onToggleAcknowledged'];
}) {
  const body = (
    <ul className="space-y-2">
      {rows.map((write) => (
        <ReviewRow
          key={operationKey(write.resourceKey, write.locationId)}
          write={write}
          preview={preview}
          draft={draft}
          onSelectStrategy={onSelectStrategy}
          onToggleAcknowledged={onToggleAcknowledged}
        />
      ))}
    </ul>
  );

  // Already-in-sync rows are folded away but never dropped: the user chose those
  // destinations, and silence about them would read as an omission.
  if (group === 'noop') {
    return (
      <details
        className="rounded-xl border border-outline-variant/15 p-3"
        data-testid="review-noop"
      >
        <summary className="cursor-pointer font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
          {`${label} (${rows.length})`}
        </summary>
        <div className="mt-2">{body}</div>
      </details>
    );
  }

  return (
    <section className="space-y-1.5" data-testid="review-group" data-group={group}>
      <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
        {`${label} (${rows.length})`}
      </h3>
      {body}
    </section>
  );
}

function ReviewRow({
  write,
  preview,
  draft,
  onSelectStrategy,
  onToggleAcknowledged,
}: {
  readonly write: PlannedWrite;
  readonly preview: PropagationPreview;
  readonly draft: WizardDraft;
  readonly onSelectStrategy: ReviewStepProps['onSelectStrategy'];
  readonly onToggleAcknowledged: ReviewStepProps['onToggleAcknowledged'];
}) {
  const { t } = useI18n();
  const l = t.library;
  const entry = preview.entries.find((candidate) => candidate.resourceKey === write.resourceKey);
  const winner = entry
    ? entry.sourceGroups.find(
        (group) => group.contentHash === resolutionFor(draft, write.resourceKey).winnerContentHash
      )
    : undefined;
  const current = write.destination.currentContentHash;
  const key = operationKey(write.resourceKey, write.locationId);

  return (
    <li
      className="space-y-2 rounded-lg border border-outline-variant/15 bg-surface-container p-2.5"
      data-testid="review-row"
      data-operation={write.operation}
      data-resource-key={write.resourceKey}
      data-location-id={write.locationId}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-on-surface text-xs">
          {entry?.ref.slug ?? write.resourceKey}
        </span>
        <span className="min-w-0 break-all font-mono text-[11px] text-on-surface-variant/70">
          {write.destination.path ?? write.locationId}
        </span>
      </div>

      {write.blockedReason && <BlockedReason reason={write.blockedReason} />}

      {write.adaptation && entry && (
        <AdaptationNotes
          adaptation={write.adaptation}
          resourceKey={write.resourceKey}
          locationId={write.locationId}
          selected={effectiveStrategy(write, draft)}
          acknowledged={draft.acknowledged.has(key)}
          onSelectStrategy={(strategy) =>
            onSelectStrategy(write.resourceKey, write.locationId, strategy)
          }
          onToggleAcknowledged={() => onToggleAcknowledged(write.resourceKey, write.locationId)}
        />
      )}

      {/*
        The destructive case. Showing which bytes lose is the entire reason this
        step exists, so the diff is inline and expanded, not behind a toggle.
      */}
      {write.operation === 'overwrite' && entry && winner && current && (
        <div className="space-y-1" data-testid="overwrite-diff">
          <p className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.review.overwriteDiff}
          </p>
          <InstanceDiff
            resourceKey={write.resourceKey}
            kind={entry.ref.kind}
            left={{ locationId: write.locationId, contentHash: current }}
            right={{ locationId: winner.contentLocationId, contentHash: winner.contentHash }}
            whitespaceOnly={false}
          />
        </div>
      )}

      {write.operation === 'noop' && current && (
        <p className="text-[11px] text-on-surface-variant/60">
          {formatMessage(l.destination.currentContent, { hash: `${hashPrefix(current)}…` })}
        </p>
      )}
    </li>
  );
}
