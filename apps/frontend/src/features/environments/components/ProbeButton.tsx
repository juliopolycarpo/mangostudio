/**
 * The re-check affordance for one entity. A probe that fails has to say so:
 * the card keeps rendering its last known state, so a silent failure reads as
 * "nothing changed" when it actually means "this may be stale".
 */

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

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
        <p role="status" className="text-xs text-error" data-testid="probe-error">
          {e.actions.refreshFailed}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        loading={isPending}
        onClick={onProbe}
        aria-label={e.actions.refresh}
      >
        <RefreshCw size={14} />
      </Button>
    </>
  );
}
