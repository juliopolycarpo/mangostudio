/**
 * The format conversion a write needs: which strategy, and what it costs.
 *
 * Every dropped field is listed inline rather than summarized. A conversion
 * that silently loses a `tools:` list is exactly the failure a review step is
 * supposed to catch, so the notes are the point of this component, not a
 * footnote to it.
 */

import type {
  AdapterStrategy,
  AdaptNote,
  LibraryLocationId,
  PropagationAdaptation,
} from '@mangostudio/shared/library';
import { useId } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

interface AdaptationNotesProps {
  readonly adaptation: PropagationAdaptation;
  readonly resourceKey: string;
  readonly locationId: LibraryLocationId;
  readonly selected: AdapterStrategy | undefined;
  readonly acknowledged: boolean;
  readonly notes?: readonly AdaptNote[];
  readonly onSelectStrategy: (strategy: AdapterStrategy) => void;
  readonly onToggleAcknowledged: () => void;
}

export function AdaptationNotes({
  adaptation,
  resourceKey,
  locationId,
  selected,
  acknowledged,
  notes,
  onSelectStrategy,
  onToggleAcknowledged,
}: AdaptationNotesProps) {
  const { t } = useI18n();
  const l = t.library;
  const groupName = useId();
  const acknowledgeId = useId();
  const strategy = selected ?? adaptation.recommendedStrategy;

  return (
    <div
      className="space-y-2 rounded-lg border border-outline-variant/15 bg-surface-container/60 p-2.5"
      data-testid="adaptation-notes"
      data-resource-key={resourceKey}
      data-location-id={locationId}
    >
      <p className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
        {l.adaptation.heading}
      </p>
      <p className="text-[11px] text-on-surface-variant">
        {formatMessage(l.adaptation.fromTo, {
          from: l.format[adaptation.fromFormat],
          to: l.format[adaptation.toFormat],
        })}
      </p>

      <div className="space-y-1.5">
        {adaptation.availableStrategies.map((candidate) => (
          <label
            key={candidate}
            className="flex cursor-pointer items-start gap-2 text-[11px] text-on-surface"
          >
            <input
              type="radio"
              name={groupName}
              value={candidate}
              checked={strategy === candidate}
              onChange={() => onSelectStrategy(candidate)}
              className="mt-0.5 size-3 accent-primary"
            />
            <span className="min-w-0">
              <span className="font-medium">{l.adaptation.strategy[candidate]}</span>
              {adaptation.recommendedStrategy === candidate && (
                <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                  {l.adaptation.recommended}
                </span>
              )}
              <span className="block text-on-surface-variant/70">
                {l.adaptation.strategyHint[candidate]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {notes && notes.length > 0 && (
        <ul className="space-y-1" data-testid="adaptation-note-list">
          {notes.map((note) => (
            <li
              key={`${note.code}:${note.field ?? ''}:${note.message}`}
              className="text-[11px] text-tertiary"
            >
              <span className="font-medium">{l.adaptation.note[note.code]}</span>
              {note.field && <span className="font-mono"> {note.field}</span>}
              <span className="text-on-surface-variant/70"> — {note.message}</span>
            </li>
          ))}
        </ul>
      )}

      {/*
        A model-drafted conversion can never be applied on the preview alone:
        `requiresReview` is always true for it, so the sign-off is the gate.
      */}
      {strategy === 'agent' && (
        <label
          htmlFor={acknowledgeId}
          className="flex cursor-pointer items-start gap-2 rounded-lg bg-error/5 p-2 text-[11px] text-on-surface"
        >
          <input
            id={acknowledgeId}
            type="checkbox"
            checked={acknowledged}
            onChange={onToggleAcknowledged}
            data-testid="adaptation-acknowledge"
            className="mt-0.5 size-3.5 accent-primary"
          />
          <span>{l.adaptation.acknowledge}</span>
        </label>
      )}
    </div>
  );
}
