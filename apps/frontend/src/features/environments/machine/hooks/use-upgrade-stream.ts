/**
 * Raw-`fetch` consumer for `POST /api/machine/upgrade`.
 *
 * Unlike `useInstallStream`, this is POST-triggered once per dialog open, not
 * an effect keyed on an id: a POST cannot be replayed, so there is no
 * reconnect loop, only one connection attempt started by `start()`.
 *
 * The endpoint can refuse before it ever opens a stream — a plain JSON 403
 * (the loopback guard) or 409 (the upgrade guard) — so the first thing `start`
 * does is look at the response before assuming its body is SSE.
 */

import type {
  MachineUpgradeBody,
  UpgradeRefusalReason,
  UpgradeReport,
  UpgradeStage,
  UpgradeStreamEvent,
} from '@mangostudio/shared/updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiBaseUrl } from '@/lib/api-base-url';
import { ApiError } from '@/lib/utils';
import { type MachineActionRefusal, refusalOrThrow } from '../api';

/** Same budget as `INSTALL_CONSOLE_MAX_LINES`; kept local, the two consoles are unrelated features. */
export const UPGRADE_CONSOLE_MAX_LINES = 2000;

/**
 * Kept module-private: only {@link UseUpgradeStreamResult} — the hook's whole
 * public surface — needs to name a shape outside this file.
 */
interface UpgradeStageEntry {
  readonly stage: UpgradeStage;
  readonly detail?: string;
}

interface UpgradeOutputLine {
  readonly id: number;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

type UpgradePhase = 'idle' | 'connecting' | 'streaming' | 'done' | 'refused' | 'failed';

interface UseUpgradeStreamState {
  readonly phase: UpgradePhase;
  readonly stages: readonly UpgradeStageEntry[];
  readonly lines: readonly UpgradeOutputLine[];
  readonly report: UpgradeReport | null;
  readonly refusal: MachineActionRefusal<UpgradeRefusalReason> | null;
  /** The server's own text for a top-level `SSEErrorEvent`, or a stream that ended with no `done` event. */
  readonly streamError: string | null;
}

export interface UseUpgradeStreamResult extends UseUpgradeStreamState {
  start(body: MachineUpgradeBody): void;
  reset(): void;
}

const IDLE_STATE: UseUpgradeStreamState = {
  phase: 'idle',
  stages: [],
  lines: [],
  report: null,
  refusal: null,
  streamError: null,
};

function parseEvent(payload: string): UpgradeStreamEvent | null {
  try {
    return JSON.parse(payload) as UpgradeStreamEvent;
  } catch {
    return null;
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type SetState = (updater: (previous: UseUpgradeStreamState) => UseUpgradeStreamState) => void;

/** One connection attempt: a pre-stream refusal, a thrown failure, or an SSE stream read to its end. */
async function run(
  controller: AbortController,
  body: MachineUpgradeBody,
  setState: SetState
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/machine/upgrade`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    setState((previous) => ({ ...previous, phase: 'failed', streamError: message }));
    return;
  }

  if (!response.ok || !response.body) {
    const value = await readJsonBody(response);
    try {
      const refusal = refusalOrThrow<UpgradeRefusalReason>({ status: response.status, value });
      setState((previous) => ({ ...previous, phase: 'refused', refusal }));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      setState((previous) => ({ ...previous, phase: 'failed', streamError: message }));
    }
    return;
  }

  setState((previous) => ({ ...previous, phase: 'streaming' }));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nextLineId = 0;
  let sawDone = false;

  const handleEvent = (event: UpgradeStreamEvent) => {
    if (event.type === 'stage') {
      setState((previous) => ({
        ...previous,
        stages: [...previous.stages, { stage: event.stage, detail: event.detail }],
      }));
      return;
    }
    if (event.type === 'output') {
      setState((previous) => {
        let lines = [...previous.lines, { id: nextLineId, stream: event.stream, text: event.line }];
        nextLineId += 1;
        if (lines.length > UPGRADE_CONSOLE_MAX_LINES) {
          lines = lines.slice(lines.length - UPGRADE_CONSOLE_MAX_LINES);
        }
        return { ...previous, lines };
      });
      return;
    }
    if (event.type === 'done') {
      sawDone = true;
      const { type: _type, done: _done, ...report } = event;
      setState((previous) => ({ ...previous, phase: 'done', report: report as UpgradeReport }));
      return;
    }
    // The remaining member of the union is `SSEErrorEvent`.
    sawDone = true;
    setState((previous) => ({ ...previous, phase: 'failed', streamError: event.error }));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        const event = parseEvent(part.slice(6));
        if (event) handleEvent(event);
      }

      if (sawDone) break;
    }
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    setState((previous) => ({ ...previous, phase: 'failed', streamError: message }));
    return;
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  // The body closed without a `type: 'done'` event ever arriving — a dropped
  // connection, not a completed upgrade. Surfacing it as `failed` keeps a cut
  // connection from reading as a silent success.
  if (!sawDone) {
    setState((previous) => ({ ...previous, phase: 'failed', streamError: null }));
  }
}

export function useUpgradeStream(): UseUpgradeStreamResult {
  const [state, setState] = useState<UseUpgradeStreamState>(IDLE_STATE);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE_STATE);
  }, []);

  const start = useCallback((body: MachineUpgradeBody) => {
    // One connection attempt per dialog open; a second `start()` while one is
    // already live is a no-op rather than a second in-flight upgrade.
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ ...IDLE_STATE, phase: 'connecting' });

    void run(controller, body, setState).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
    });
  }, []);

  return { ...state, start, reset };
}
