/**
 * The re-check affordance for one entity. A probe that fails has to say so:
 * the card keeps rendering its last known state, so a silent failure reads as
 * "nothing changed" when it actually means "this may be stale".
 */

import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

interface ProbeButtonProps {
  isPending: boolean;
  isError: boolean;
  onProbe: () => void;
}

export function ProbeButton({ isPending, isError, onProbe }: ProbeButtonProps) {
  const { t } = useI18n();
  const e = t.environments;

  return (
    <>
      {isError && (
        <p
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
          role="status"
          className="text-xs text-danger"
          data-testid="probe-error"
        >
          {e.actions.refreshFailed}
        </p>
      )}
      <Button
        variant="subtle"
        size="icon"
        loading={isPending}
        onClick={onProbe}
        aria-label={e.actions.refresh}
      >
        {/* The button's own spinner stands in for the glyph while it runs. */}
        {isPending ? null : <RefreshCw size={ICON_MD} />}
      </Button>
    </>
  );
}
