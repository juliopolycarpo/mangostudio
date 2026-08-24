import type { EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { Server } from 'lucide-react';
import { useId, useState } from 'react';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useEnvironmentEntitiesQuery } from '../queries';

const STATUS_TONE: Record<EnvironmentConnectionState, StatusDotTone> = {
  connected: 'accent',
  connecting: 'warning',
  disconnected: 'neutral',
  error: 'error',
};

interface EnvironmentSelectorProps {
  environmentId: string;
  disabled?: boolean;
  onEnvironmentChange: (environmentId: string) => void | Promise<void>;
}

export function EnvironmentSelector({
  environmentId,
  disabled = false,
  onEnvironmentChange,
}: EnvironmentSelectorProps) {
  const { t } = useI18n();
  const statusId = useId();
  const environments = useEnvironmentEntitiesQuery();
  const [isChanging, setIsChanging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const selected = environments.data?.find((environment) => environment.id === environmentId);

  const handleChange = async (nextEnvironmentId: string) => {
    if (nextEnvironmentId === environmentId) return;
    setIsChanging(true);
    setActionError(null);
    try {
      await onEnvironmentChange(nextEnvironmentId);
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, t.chat.input.environmentUpdateFailed));
    } finally {
      setIsChanging(false);
    }
  };

  const unavailable = environments.isPending && !environments.data;
  const status = selected?.status.state ?? 'disconnected';
  const statusLabel = t.environments.entities.status[status];

  return (
    <div className="flex items-center">
      <label
        className={`composer-chip max-w-[13rem] ${actionError ? 'border-error/45 text-error' : ''}`}
        title={actionError ?? selected?.name ?? t.chat.input.selectEnvironment}
        data-testid="environment-selector"
        data-state={status}
      >
        <Server size={11} className="shrink-0 text-primary/80" aria-hidden="true" />
        <StatusDot tone={STATUS_TONE[status]} pulse={status === 'connecting'} />
        <span className="shrink-0 text-on-surface-variant/70">{`${t.chat.input.environmentLabel}:`}</span>
        <span id={statusId} className="sr-only">
          {statusLabel}
        </span>
        <select
          value={environmentId}
          onChange={(event) => void handleChange(event.target.value)}
          disabled={disabled || isChanging || unavailable || environments.isError}
          className="composer-chip-value min-w-0 max-w-[9rem] appearance-none bg-transparent text-inherit outline-none disabled:opacity-60"
          aria-label={t.chat.input.selectEnvironment}
          aria-describedby={statusId}
        >
          {unavailable ||
          !environments.data?.some((environment) => environment.id === environmentId) ? (
            <option value={environmentId}>
              {unavailable ? t.chat.input.environmentsLoading : environmentId}
            </option>
          ) : null}
          {environments.data?.map((environment) => (
            <option key={environment.id} value={environment.id} disabled={!environment.enabled}>
              {environment.name}
            </option>
          ))}
        </select>
      </label>
      {actionError ? (
        <span className="sr-only" role="alert">
          {actionError}
        </span>
      ) : null}
    </div>
  );
}
