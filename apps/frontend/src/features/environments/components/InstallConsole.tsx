/**
 * Live install log.
 *
 * Lines are appended verbatim. Autoscroll follows the tail until the user
 * scrolls up — reading the line that just failed must not be fought by the
 * viewport — and re-engages when they scroll back to the bottom.
 */

import { CircleCheck, CircleX, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatDuration } from '../format';
import type { InstallStreamState } from '../hooks/use-install-stream';

interface InstallConsoleProps {
  stream: InstallStreamState;
  /** Which step of a prerequisite chain this run is; absent for a lone install. */
  stepLabel?: string;
  onCancel: () => void;
  onClose: () => void;
}

/** How close to the bottom still counts as "following the tail", in pixels. */
const AUTOSCROLL_THRESHOLD_PX = 32;

const STREAM_STYLES = {
  stdout: 'text-fg-muted',
  stderr: 'text-danger',
  system: 'text-fg-muted italic',
} as const;

export function InstallConsole({ stream, stepLabel, onCancel, onClose }: InstallConsoleProps) {
  const { t } = useI18n();
  const s = t.environments.install;
  const logRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);

  // Re-pin to the tail on every new line, but only while autoscroll is engaged.
  useEffect(() => {
    if (!autoscroll) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [autoscroll, stream.lines]);

  const handleScroll = () => {
    const element = logRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAutoscroll(distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX);
  };

  const isRunning = stream.phase === 'connecting' || stream.phase === 'streaming';
  const exit = stream.exit;

  return (
    <section
      className="space-y-3 rounded-2xl border border-stroke bg-control p-4"
      data-testid="install-console"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon phase={stream.phase} exitStatus={exit?.status} />
          <span className="text-sm font-semibold text-fg">
            {exit ? s.runStatus[exit.status] : s.runStatus.running}
          </span>
          {stepLabel && (
            <span className="truncate text-xs text-fg-muted" data-testid="install-step-label">
              {stepLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(event) => setAutoscroll(event.target.checked)}
              className="accent-accent"
            />
            {s.autoscroll}
          </label>
          {isRunning ? (
            <Button variant="subtle" size="sm" onClick={onCancel}>
              {s.cancelRun}
            </Button>
          ) : (
            <Button variant="subtle" size="sm" onClick={onClose}>
              {s.close}
            </Button>
          )}
        </div>
      </header>

      {stream.reconnecting && <p className="text-xs text-info">{s.reconnecting}</p>}
      {stream.droppedLines > 0 && (
        <p className="text-xs text-fg-muted">
          {formatMessage(s.linesDropped, { count: String(stream.droppedLines) })}
        </p>
      )}

      <div
        ref={logRef}
        onScroll={handleScroll}
        className="max-h-72 overflow-y-auto rounded-xl bg-fill-selected p-3 font-mono text-xs leading-relaxed"
        // A `log` role is the live region for append-only output, so a screen
        // reader hears progress without the user having to poll it.
        role="log"
        aria-live="polite"
        aria-label={s.consoleTitle}
      >
        {stream.lines.length === 0 ? (
          <p className="text-fg-subtle">{s.waitingForOutput}</p>
        ) : (
          stream.lines.map((line) => (
            <div
              key={line.id}
              className={`whitespace-pre-wrap break-all ${STREAM_STYLES[line.stream]}`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      {exit && (
        <p className="text-xs text-fg-muted" data-testid="install-exit-summary">
          {exit.code === null
            ? formatMessage(s.exitSummaryNoCode, { duration: formatDuration(exit.durationMs) })
            : formatMessage(s.exitSummary, {
                code: String(exit.code),
                duration: formatDuration(exit.durationMs),
              })}
        </p>
      )}
      {exit?.truncated && <p className="text-xs text-fg-muted">{s.truncated}</p>}
      {stream.phase === 'failed' && !exit && (
        // The server's own explanation beats the generic one whenever it sent
        // an error event rather than simply dropping the connection.
        <p className="text-xs text-danger">{stream.streamError ?? s.streamError}</p>
      )}
    </section>
  );
}

function StatusIcon({
  phase,
  exitStatus,
}: {
  phase: InstallStreamState['phase'];
  exitStatus: string | undefined;
}) {
  if (phase === 'connecting' || phase === 'streaming') {
    return <LoaderCircle size={16} className="animate-spin text-accent-fg" />;
  }
  if (exitStatus === 'succeeded') return <CircleCheck size={16} className="text-accent-fg" />;
  if (exitStatus === 'interrupted') return <TriangleAlert size={16} className="text-info" />;
  return <CircleX size={16} className="text-danger" />;
}
