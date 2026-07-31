import type { EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { Server } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useEnvironmentEntitiesQuery } from '../queries';

const STATUS_DOT: Record<EnvironmentConnectionState, string> = {
  connected: 'bg-primary',
  connecting: 'bg-warning animate-pulse',
  disconnected: 'bg-outline',
  error: 'bg-error',
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

  return (
    <div className="flex items-center">
      <label
        className={`flex h-7 max-w-[13rem] items-center gap-1.5 rounded-full border bg-surface-container-lowest pl-2 text-[10px] font-medium transition-colors sm:text-[11px] ${
          actionError
            ? 'border-error/45 text-error'
            : 'border-outline-variant/20 text-on-surface-variant hover:border-primary/30 hover:text-on-surface'
        }`}
        title={actionError ?? selected?.name ?? t.chat.input.selectEnvironment}
        data-testid="environment-selector"
        data-state={status}
      >
        <Server size={12} className="shrink-0 text-primary/80" aria-hidden="true" />
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
          aria-hidden="true"
        />
        <span className="sr-only">{t.chat.input.selectEnvironment}</span>
        <select
          value={environmentId}
          onChange={(event) => void handleChange(event.target.value)}
          disabled={disabled || isChanging || unavailable || environments.isError}
          className="min-w-0 max-w-[9rem] appearance-none bg-transparent py-1 pr-2 text-inherit outline-none disabled:opacity-60"
          aria-label={t.chat.input.selectEnvironment}
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
