/**
 * "This machine": the hub process serving this page, whether a service keeps
 * it alive, the install around it, doctor, and the log tail.
 *
 * The page is about the process it talks to, so an action that succeeds makes
 * the server go away for a moment. The status query keeps polling through
 * that and the banner says so; the page never pretends the old process is
 * still the one answering.
 */

import type { MachineActionResponse, MachineServiceAction } from '@mangostudio/shared/machine';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import type { MachineActionResult } from '../api';
import {
  useChangeMachineServiceMutation,
  useMachineStatus,
  useRestartMachineMutation,
} from '../queries';
import { DoctorSection } from './DoctorSection';
import { HubProcessCard } from './HubProcessCard';
import { InstallFactsCard } from './InstallFactsCard';
import { LogTail } from './LogTail';
import { ServiceCard } from './ServiceCard';

export function MachinePage() {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { toast } = useToast();
  const status = useMachineStatus();
  const restart = useRestartMachineMutation();
  const service = useChangeMachineServiceMutation();
  const [notice, setNotice] = useState<string | null>(null);

  /** The accepted action worded here, since the hub does not know this locale. */
  const acceptedNotice = (response: MachineActionResponse): string => {
    const accepted = m.actions.accepted;
    return formatMessage(accepted[response.outcome], {
      unit: response.unit ?? accepted.unnamedUnit,
    });
  };

  const settle = (result: MachineActionResult) => {
    if (result.outcome === 'accepted') {
      setNotice(acceptedNotice(result.response));
      status.expectChange();
      return;
    }
    toast(result.message || m.actions.refused, 'error');
  };
  const fail = () => toast(m.actions.failed, 'error');

  const onRestart = () => restart.mutate(undefined, { onSuccess: settle, onError: fail });
  const onService = (action: MachineServiceAction) =>
    service.mutate(action, { onSuccess: settle, onError: fail });

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="text-sm text-on-surface-variant/60">{m.description}</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void status.refetch()}
        loading={status.isFetching && Boolean(status.data)}
      >
        <RefreshCw size={14} />
        {m.refresh}
      </Button>
    </div>
  );

  if (status.isPending && !status.data) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentPageState variant="loading" />
      </div>
    );
  }

  if (!status.data) {
    return (
      <div className="space-y-4">
        {header}
        {status.awaitingChange ? (
          <EnvironmentPageState variant="loading" title={m.reconnecting} />
        ) : (
          <EnvironmentPageState variant="error" onRetry={() => void status.refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}

      {(notice || status.awaitingChange) && (
        <div
          className="rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-on-surface"
          data-testid="machine-notice"
        >
          {status.awaitingChange ? (notice ?? m.reconnecting) : notice}
          {status.awaitingChange && status.error && (
            <span className="text-on-surface-variant/70"> {m.reconnecting}</span>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <HubProcessCard
          status={status.data}
          isRestarting={restart.isPending}
          onRestart={onRestart}
        />
        <ServiceCard
          status={status.data}
          isPending={service.isPending}
          onInstall={() => onService('install')}
          onUninstall={() => onService('uninstall')}
        />
      </div>

      <InstallFactsCard status={status.data} />
      <DoctorSection />
      <LogTail />
    </div>
  );
}
