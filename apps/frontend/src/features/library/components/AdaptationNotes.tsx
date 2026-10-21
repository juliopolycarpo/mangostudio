/**
 * The format conversion a write needs: which strategy, and what it costs.
 *
 * The preview knows the strategies on offer and the one it recommends; what a
 * conversion actually dropped is only known after it ran, so the result panel is
 * where those notes are listed.
 */

import type {
  AdapterStrategy,
  LibraryLocationId,
  PropagationAdaptation,
} from '@mangostudio/shared/library';
import { useId } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ChoiceRow } from './ChoiceRow';

interface AdaptationNotesProps {
  readonly adaptation: PropagationAdaptation;
  readonly resourceKey: string;
  readonly locationId: LibraryLocationId;
  readonly selected: AdapterStrategy | undefined;
  readonly acknowledged: boolean;
  readonly onSelectStrategy: (strategy: AdapterStrategy) => void;
  readonly onToggleAcknowledged: () => void;
}

export function AdaptationNotes({
  adaptation,
  resourceKey,
  locationId,
  selected,
  acknowledged,
  onSelectStrategy,
  onToggleAcknowledged,
}: AdaptationNotesProps) {
  const { t } = useI18n();
  const l = t.library;
  const groupName = useId();
  const acknowledgeId = useId();
  const strategy = selected ?? adaptation.recommendedStrategy;

  return (
    // Divided from the row it belongs to by a hairline, not boxed: it already sits
    // inside the review row's card.
    <div
      className="space-y-3 border-stroke border-t pt-3"
      data-testid="adaptation-notes"
      data-resource-key={resourceKey}
      data-location-id={locationId}
    >
      <div className="space-y-1">
        <MicroLabel as="p">{l.adaptation.heading}</MicroLabel>
        <p className="text-fg-muted text-xs">
          {formatMessage(l.adaptation.fromTo, {
            from: l.format[adaptation.fromFormat],
            to: l.format[adaptation.toFormat],
          })}
        </p>
      </div>

      <div className="space-y-1">
        {adaptation.availableStrategies.map((candidate) => (
          <ChoiceRow
            key={candidate}
            control="radio"
            name={groupName}
            value={candidate}
            checked={strategy === candidate}
            onChange={() => onSelectStrategy(candidate)}
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-fg text-sm">
                {l.adaptation.strategy[candidate]}
              </span>
              {adaptation.recommendedStrategy === candidate && (
                <Badge variant="accent">{l.adaptation.recommended}</Badge>
              )}
            </span>
            <span className="block text-fg-muted text-xs">
              {l.adaptation.strategyHint[candidate]}
            </span>
          </ChoiceRow>
        ))}
      </div>

      {/*
        A model-drafted conversion can never be applied on the preview alone:
        `requiresReview` is always true for it, so the sign-off is the gate.
      */}
      {strategy === 'agent' && (
        <Callout tone="warning">
          <label htmlFor={acknowledgeId} className="flex cursor-pointer items-center gap-2 text-fg">
            <Checkbox
              id={acknowledgeId}
              checked={acknowledged}
              onChange={onToggleAcknowledged}
              data-testid="adaptation-acknowledge"
            />
            <span>{l.adaptation.acknowledge}</span>
          </label>
        </Callout>
      )}
    </div>
  );
}
