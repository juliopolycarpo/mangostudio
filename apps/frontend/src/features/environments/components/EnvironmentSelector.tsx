import { Server } from 'lucide-react';
import { useId, useState } from 'react';

import { ChipSelect } from '@/components/ui/ChipSelect';
import { LockedChip } from '@/components/ui/LockedChip';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';

import { useEnvironmentEntitiesQuery } from '../queries';
import { ENVIRONMENT_STATE_TONE } from './environment-status-tone';

interface EnvironmentSelectorProps {
  environmentId: string;
  /**
   * The chat has settled where it runs — it has turns, or one is generating —
   * so the chip states the environment instead of offering a choice. A fact,
   * not a disabled control: it keeps full-strength text and drops the chevron.
   */
  locked?: boolean;
  /** The control is merely off. It fades, as any disabled control does. */
  disabled?: boolean;
  onEnvironmentChange: (environmentId: string) => void | Promise<void>;
}

/**
 * Which machine a session runs on, as a `key: value` chip with a connection dot.
 *
 * Lives in the header and in a page's title row, both near the top of the
 * viewport, so its listbox opens downward: the composer's upward default would
 * put the panel above the window.
 *
 * With only one environment there is nothing to choose: a menu holding one
 * checked row and no way out read as a broken list. The chip states the fact
 * instead, as it does for a chat that has started, and its reason says where a
 * second environment comes from.
 */
export function EnvironmentSelector({
  environmentId,
  locked = false,
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
  const onlyChoice = environments.data?.length === 1 && environments.data[0]?.id === environmentId;
  const status = selected?.status.state ?? 'disconnected';
  const statusLabel = t.environments.entities.status[status];

  const icon = <Server size={ICON_SM} className="composer-chip-icon shrink-0" aria-hidden="true" />;
  const adornment = (
    <StatusDot tone={ENVIRONMENT_STATE_TONE[status]} pulse={status === 'connecting'} />
  );

  return (
    <div className="flex items-center">
      <span id={statusId} className="sr-only">
        {statusLabel}
      </span>
      {locked || onlyChoice ? (
        <LockedChip
          label={t.chat.input.environmentLabel}
          // The listing may not have landed; until it does the only name for
          // the current environment is its id.
          value={selected?.name ?? environmentId}
          reason={locked ? t.chat.input.environmentLocked : t.chat.input.environmentOnlyOne}
          icon={icon}
          adornment={adornment}
          describedBy={statusId}
          testId="environment-selector"
          dataState={status}
        />
      ) : (
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
          icon={icon}
          adornment={adornment}
          title={actionError ?? selected?.name ?? t.chat.input.selectEnvironment}
          describedBy={statusId}
          className={actionError ? 'border-danger text-danger' : undefined}
          placement="below"
          testId="environment-selector"
          dataState={status}
        />
      )}
      {actionError ? (
        <span className="sr-only" role="alert">
          {actionError}
        </span>
      ) : null}
    </div>
  );
}
