/**
 * The last lines of the hub's log file. Bounded on the server, refreshed on
 * demand; a foreground start has no file and says so instead of showing an
 * empty box.
 */

import type { MachineLogTail } from '@mangostudio/shared/machine';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';

import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { machineGuardReasonLabel } from '../format';
import { useMachineLogs } from '../queries';
import { MachineCard } from './MachineCard';

function LogBody({ tail }: { readonly tail: MachineLogTail }) {
  const { t } = useI18n();
  const m = t.environments.machine.logs;
  return (
    <>
      <p className="truncate font-mono text-xs text-fg-muted">
        {tail.truncated
          ? formatMessage(m.truncated, { count: String(tail.lines.length), file: tail.file ?? '' })
          : tail.file}
      </p>
      {tail.lines.length === 0 ? (
        <p className="text-sm text-fg-muted">{m.empty}</p>
      ) : (
        <pre className="app-scrollbar max-h-80 overflow-auto rounded-md border border-stroke bg-canvas p-3 font-mono text-xs leading-relaxed text-fg">
          {tail.lines.join('\n')}
        </pre>
      )}
    </>
  );
}

/**
 * What the card shows below its header. Written as early returns rather than
 * one chain: the first two arms are the rule "do not blank a section that
 * already has content", and a sixth state would re-indent the whole thing.
 */
function LogContent({ logs }: { readonly logs: ReturnType<typeof useMachineLogs> }) {
  const { t } = useI18n();
  const m = t.environments.machine.logs;

  if (logs.isPending && !logs.data)
    return <EnvironmentPageState variant="loading" size="section" />;
  if (logs.error && !logs.data) {
    return (
      <EnvironmentPageState variant="error" size="section" onRetry={() => void logs.refetch()} />
    );
  }
  if (!logs.data) return null;
  if (logs.data.outcome === 'refused') {
    return (
      <div className="space-y-1" data-testid="machine-logs-refused">
        {logs.data.reasons.map((reason) => (
          <p key={reason} className="text-sm text-fg-muted">
            {machineGuardReasonLabel(t, reason)}
          </p>
        ))}
        <p className="text-sm text-fg-muted">{m.readLocally}</p>
      </div>
    );
  }
  if (!logs.data.tail.file) return <p className="text-sm text-fg-muted">{m.none}</p>;
  return <LogBody tail={logs.data.tail} />;
}

export function LogTail() {
  const { t } = useI18n();
  const m = t.environments.machine.logs;
  const logs = useMachineLogs();

  return (
    <MachineCard
      title={m.title}
      testId="machine-logs"
      action={
        <Button
          variant="subtle"
          size="sm"
          onClick={() => void logs.refetch()}
          loading={logs.isFetching && Boolean(logs.data)}
        >
          <RefreshCw size={ICON_SM} />
          {t.environments.machine.refresh}
        </Button>
      }
    >
      <LogContent logs={logs} />
    </MachineCard>
  );
}
