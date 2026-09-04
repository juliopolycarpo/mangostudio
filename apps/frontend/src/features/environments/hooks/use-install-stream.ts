/**
 * SSE consumer for a running install.
 *
 * Owns three things the console cannot get wrong: a line cap so a chatty
 * installer cannot pin the tab, reconnect on a transient drop, and cleanup on
 * unmount. The server replays its whole buffer to every new subscriber, so a
 * reconnect restarts the line buffer rather than appending a second copy.
 */

import type {
  InstallExitEvent,
  InstallProbeEvent,
  InstallStreamEvent,
} from '@mangostudio/shared/environments';
import { useEffect, useEffectEvent, useState } from 'react';
import { getApiBaseUrl } from '@/lib/api-base-url';

/**
 * Roughly the server's 1 MiB output budget at a typical line length. The cap is
 * a correctness requirement, not a polish item: installers emit progress bars
 * line by line and an uncapped buffer grows without bound.
 */
export const INSTALL_CONSOLE_MAX_LINES = 2000;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 750;

interface InstallStreamLine {
  /** Monotonic across the run, so React keys stay stable while lines are dropped. */
  readonly id: number;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly text: string;
}

type InstallStreamPhase = 'idle' | 'connecting' | 'streaming' | 'finished' | 'failed';

export interface InstallStreamState {
  readonly lines: readonly InstallStreamLine[];
  /** Lines discarded at the head of the buffer once the cap was reached. */
  readonly droppedLines: number;
  readonly phase: InstallStreamPhase;
  readonly exit: InstallExitEvent | null;
  readonly reconnecting: boolean;
  /** The server's own explanation when it ended the stream with an error event. */
  readonly streamError: string | null;
}

/**
 * How one connection attempt ended. Only `dropped` is retryable: an exit means
 * the buffer is complete, and a server-sent error means retrying replays the
 * same failure.
 */
type ConsumeOutcome = 'exited' | 'failed' | 'dropped';

export interface UseInstallStreamOptions {
  readonly runId: string | null;
  /**
   * Absolute path under the API base for the SSE log. Defaults to the
   * environments install run stream. Runtime lifecycle passes its own path.
   */
  readonly streamPath?: string | null;
  readonly maxLines?: number;
  readonly onProbe?: (event: InstallProbeEvent) => void;
  readonly onExit?: (event: InstallExitEvent) => void;
}

const IDLE_STATE: InstallStreamState = {
  lines: [],
  droppedLines: 0,
  phase: 'idle',
  exit: null,
  reconnecting: false,
  streamError: null,
};

function parseEvent(payload: string): InstallStreamEvent | null {
  try {
    return JSON.parse(payload) as InstallStreamEvent;
  } catch {
    return null;
  }
}

export function useInstallStream({
  runId,
  streamPath,
  maxLines = INSTALL_CONSOLE_MAX_LINES,
  onProbe,
  onExit,
}: UseInstallStreamOptions): InstallStreamState {
  const [state, setState] = useState<InstallStreamState>(IDLE_STATE);
  // Effect events rather than refs assigned during render: the stream fires
  // from inside the effect below, and React hands these the callbacks of the
  // render that actually committed — no render-time write a discarded render
  // could leave behind, and no commit-order gap an effect-synced ref would open.
  const emitProbe = useEffectEvent((event: InstallProbeEvent) => onProbe?.(event));
  const emitExit = useEffectEvent((event: InstallExitEvent) => onExit?.(event));

  useEffect(() => {
    if (!runId) {
      setState(IDLE_STATE);
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // Held so cleanup can tear the body down itself rather than trusting the
    // fetch abort to propagate before the component is gone.
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const path = streamPath ?? `/api/environments/install/${encodeURIComponent(runId)}/log`;

    /** One connection attempt; see `ConsumeOutcome` for what may be retried. */
    const consume = async (): Promise<ConsumeOutcome> => {
      const response = await fetch(`${getApiBaseUrl()}${path}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Install log stream responded ${response.status}`);
      }

      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let nextLineId = 0;
      let lines: InstallStreamLine[] = [];
      let droppedLines = 0;
      let exit: InstallExitEvent | null = null;
      let streamError: string | null = null;
      let dirty = false;

      // Each `read()` can carry hundreds of lines; flushing per chunk keeps the
      // console responsive without one React render per installer line.
      const flush = () => {
        if (!dirty) return;
        dirty = false;
        const snapshot = [...lines];
        const droppedSnapshot = droppedLines;
        const exitSnapshot = exit;
        const errorSnapshot = streamError;
        setState((previous) => ({
          lines: snapshot,
          droppedLines: droppedSnapshot,
          phase: exitSnapshot ? 'finished' : errorSnapshot ? 'failed' : 'streaming',
          exit: exitSnapshot ?? previous.exit,
          reconnecting: false,
          streamError: errorSnapshot ?? previous.streamError,
        }));
      };

      const appendLine = (event: Extract<InstallStreamEvent, { type: 'log' }>) => {
        lines.push({ id: nextLineId, stream: event.stream, text: event.line });
        nextLineId += 1;
        if (lines.length > maxLines) {
          const overflow = lines.length - maxLines;
          lines = lines.slice(overflow);
          droppedLines += overflow;
        }
        dirty = true;
      };

      try {
        while (!disposed) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            const event = parseEvent(part.slice(6));
            if (!event) continue;

            if (event.type === 'log') {
              appendLine(event);
            } else if (event.type === 'probe') {
              emitProbe(event);
            } else if (event.type === 'exit') {
              exit = event;
              dirty = true;
              emitExit(event);
            } else {
              // An `error` event ends the run just as an exit does, but the
              // server sends no exit code with it. Retrying would only replay
              // the same failure, so it is terminal and keeps its own message.
              streamError = event.error;
              dirty = true;
            }
          }

          flush();
          if (exit || streamError) break;
        }
      } finally {
        activeReader = null;
        // Cancelling tears the body down and releases the lock; `releaseLock`
        // alone would leave the response open when the caller unmounted.
        void reader.cancel().catch(() => undefined);
      }

      flush();
      if (exit) return 'exited';
      return streamError ? 'failed' : 'dropped';
    };

    const run = async () => {
      for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        if (disposed) return;
        setState((previous) => ({
          ...previous,
          phase: previous.phase === 'streaming' ? 'streaming' : 'connecting',
          reconnecting: attempt > 0,
        }));

        try {
          // Both terminal outcomes have already written their own final state.
          if ((await consume()) !== 'dropped') return;
        } catch (error) {
          if (disposed || (error instanceof Error && error.name === 'AbortError')) return;
        }

        if (disposed || attempt === MAX_RECONNECT_ATTEMPTS) break;
        await new Promise<void>((resolve) => {
          reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS * (attempt + 1));
        });
      }

      if (disposed) return;
      setState((previous) =>
        previous.exit ? previous : { ...previous, phase: 'failed', reconnecting: false }
      );
    };

    void run();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      void activeReader?.cancel().catch(() => undefined);
      controller.abort();
    };
  }, [runId, streamPath, maxLines]);

  return state;
}
