/**
 * The last lines of the hub's log file. Bounded on the server, refreshed on
 * demand; a foreground start has no file and says so instead of showing an
 * empty box.
 */

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { useMachineLogs } from '../queries';

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

      {logs.isPending && !logs.data ? (
        <EnvironmentPageState variant="loading" size="section" />
      ) : logs.error && !logs.data ? (
        <EnvironmentPageState variant="error" size="section" onRetry={() => void logs.refetch()} />
      ) : !logs.data?.file ? (
        <p className="text-sm text-on-surface-variant/70">{m.none}</p>
      ) : (
        <>
          <p className="truncate font-mono text-xs text-on-surface-variant/70">
            {logs.data.truncated
              ? formatMessage(m.truncated, {
                  count: String(logs.data.lines.length),
                  file: logs.data.file,
                })
              : logs.data.file}
          </p>
          {logs.data.lines.length === 0 ? (
            <p className="text-sm text-on-surface-variant/70">{m.empty}</p>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-xl bg-surface-container-lowest p-3 font-mono text-[11px] leading-relaxed text-on-surface">
              {logs.data.lines.join('\n')}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
