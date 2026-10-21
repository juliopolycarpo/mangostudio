import { Server } from 'lucide-react';
import { useId, useState } from 'react';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useEnvironmentEntitiesQuery } from '../queries';
import { ENVIRONMENT_STATE_TONE } from './environment-status-tone';

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
      <span id={statusId} className="sr-only">
        {statusLabel}
      </span>
      <ChipSelect
        value={environmentId}
        options={(environments.data ?? []).map((environment) => ({
          value: environment.id,
          label: environment.name,
          disabled: !environment.enabled,
        }))}
        onChange={(nextEnvironmentId) => void handleChange(nextEnvironmentId)}
        label={t.chat.input.environmentLabel}
        ariaLabel={t.chat.input.selectEnvironment}
        disabled={disabled || isChanging || unavailable || environments.isError}
        // The chip renders before the listing lands; until it does the only
        // name for the current environment is its id.
        placeholder={unavailable ? t.chat.input.environmentsLoading : environmentId}
        icon={<Server size={ICON_SM} className="composer-chip-icon shrink-0" aria-hidden="true" />}
        adornment={
          <StatusDot tone={ENVIRONMENT_STATE_TONE[status]} pulse={status === 'connecting'} />
        }
        title={actionError ?? selected?.name ?? t.chat.input.selectEnvironment}
        describedBy={statusId}
        className={actionError ? 'border-danger text-danger' : undefined}
        testId="environment-selector"
        dataState={status}
      />
      {actionError ? (
        <span className="sr-only" role="alert">
          {actionError}
        </span>
      ) : null}
    </div>
  );
}
