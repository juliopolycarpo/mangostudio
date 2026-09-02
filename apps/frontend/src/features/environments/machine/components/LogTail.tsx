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
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { machineGuardReasonLabel } from '../format';
import { useMachineLogs } from '../queries';

function LogBody({ tail }: { readonly tail: MachineLogTail }) {
  const { t } = useI18n();
  const m = t.environments.machine.logs;
  return (
    <>
      <p className="truncate font-mono text-xs text-on-surface-variant/70">
        {tail.truncated
          ? formatMessage(m.truncated, { count: String(tail.lines.length), file: tail.file ?? '' })
          : tail.file}
      </p>
      {tail.lines.length === 0 ? (
        <p className="text-sm text-on-surface-variant/70">{m.empty}</p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-xl bg-surface-container-lowest p-3 font-mono text-[11px] leading-relaxed text-on-surface">
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
          <p key={reason} className="text-sm text-on-surface-variant">
            {machineGuardReasonLabel(t, reason)}
          </p>
        ))}
        <p className="text-sm text-on-surface-variant/70">{m.readLocally}</p>
      </div>
    );
  }
  if (!logs.data.tail.file) return <p className="text-sm text-on-surface-variant/70">{m.none}</p>;
  return <LogBody tail={logs.data.tail} />;
}

export function LogTail() {
  const { t } = useI18n();
  const m = t.environments.machine.logs;
  const logs = useMachineLogs();

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-3 p-5`} data-testid="machine-logs">
      <div className="flex items-center justify-between gap-3">
        <CardSectionLabel>{m.title}</CardSectionLabel>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logs.refetch()}
          loading={logs.isFetching && Boolean(logs.data)}
        >
          <RefreshCw size={14} />
          {t.environments.machine.refresh}
        </Button>
      </div>

      <LogContent logs={logs} />
    </section>
  );
}
