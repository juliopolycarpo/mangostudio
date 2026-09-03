/**
 * use-install-stream: ordering, the line cap, and cleanup.
 *
 * The cap is a correctness requirement — a runaway installer must not pin the
 * tab — and it must never cost the `exit` event, which is the only authority on
 * the outcome.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { InstallStreamEvent } from '@mangostudio/shared/environments';
import { act } from '@testing-library/react';
import {
  INSTALL_CONSOLE_MAX_LINES,
  useInstallStream,
} from '../../../../src/features/environments/hooks/use-install-stream';
import { renderHook, waitFor } from '../../../support/harness/render';

function sse(events: readonly InstallStreamEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

interface StreamingResponseOptions {
  /** Called when the body is torn down, exactly as a real cancelled fetch does. */
  readonly onCancel?: () => void;
  /** Keeps the body open after the chunks run out, as a live install does. */
  readonly keepOpen?: boolean;
}

/** A response whose body streams `chunks` and reports when it was cancelled. */
function streamingResponse(
  chunks: readonly string[],
  { onCancel, keepOpen = false }: StreamingResponseOptions = {}
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        if (keepOpen) {
          // A running installer simply has not written its next line yet.
          return new Promise<void>(() => undefined);
        }
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index] as string));
      index += 1;
      return;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200 });
}

const EXIT_EVENT: InstallStreamEvent = {
  type: 'exit',
  code: 0,
  status: 'succeeded',
  truncated: false,
  durationMs: 1500,
  done: true,
};

describe('useInstallStream', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    // `vi.stubGlobal` has no Bun equivalent. `bun.setup.ts` reinstates its
    // unreachable `fetch` after every test, so a plain assignment cannot leak.
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('appends log events in order and stops on exit', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        sse([
          { type: 'log', stream: 'stdout', line: 'first', done: false },
          { type: 'log', stream: 'stderr', line: 'second', done: false },
        ]),
        sse([EXIT_EVENT]),
      ])
    );

    const { result } = renderHook(() => useInstallStream({ runId: 'run-1' }));

    await waitFor(() => expect(result.current.exit).not.toBeNull());
    expect(result.current.lines.map((line) => line.text)).toEqual(['first', 'second']);
    expect(result.current.lines[1]?.stream).toBe('stderr');
    expect(result.current.phase).toBe('finished');
    // One connection only: an exit is complete, so there is nothing to retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops lines beyond the cap without dropping the exit', async () => {
    const maxLines = 5;
    const overflow = maxLines + 3;
    fetchMock.mockResolvedValue(
      streamingResponse([
        sse(
          Array.from({ length: overflow }, (_, index) => ({
            type: 'log' as const,
            stream: 'stdout' as const,
            line: `line-${index}`,
            done: false as const,
          }))
        ),
        sse([EXIT_EVENT]),
      ])
    );

    const { result } = renderHook(() => useInstallStream({ runId: 'run-2', maxLines }));

    await waitFor(() => expect(result.current.exit).not.toBeNull());
    expect(result.current.lines).toHaveLength(maxLines);
    expect(result.current.droppedLines).toBe(overflow - maxLines);
    // The tail is what survives: the last lines are the ones that explain a failure.
    expect(result.current.lines[0]?.text).toBe(`line-${overflow - maxLines}`);
    expect(result.current.lines.at(-1)?.text).toBe(`line-${overflow - 1}`);
    expect(result.current.exit?.status).toBe('succeeded');
  });

  it('forwards probe events without adding them to the log', async () => {
    const onProbe = jest.fn();
    fetchMock.mockResolvedValue(
      streamingResponse([
        sse([
          {
            type: 'probe',
            target: 'runtime',
            status: {
              id: 'bun',
              health: 'ok',
              installations: [],
              findings: [],
              installable: true,
              probedAtMs: 1,
            },
            done: false,
          },
          EXIT_EVENT,
        ]),
      ])
    );

    const { result } = renderHook(() => useInstallStream({ runId: 'run-3', onProbe }));

    await waitFor(() => expect(result.current.exit).not.toBeNull());
    expect(onProbe).toHaveBeenCalledTimes(1);
    expect(result.current.lines).toHaveLength(0);
  });

  it('delivers the exit to the callback from the latest render', async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(streamingResponse([sse([EXIT_EVENT])]));
        })
    );
    const stale = jest.fn();
    const latest = jest.fn();

    const { rerender } = renderHook(
      ({ onExit }: { onExit: (event: InstallStreamEvent) => void }) =>
        useInstallStream({ runId: 'run-6', onExit }),
      { initialProps: { onExit: stale } }
    );
    rerender({ onExit: latest });
    await waitFor(() => expect(release).toBeDefined());
    act(() => release?.());

    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
    expect(stale).not.toHaveBeenCalled();
  });

  it('tears the response body down on unmount', async () => {
    const onCancel = jest.fn();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(
        streamingResponse(
          [sse([{ type: 'log', stream: 'stdout', line: 'working', done: false }])],
          {
            onCancel,
            keepOpen: true,
          }
        )
      );
    });

    const { result, unmount } = renderHook(() => useInstallStream({ runId: 'run-4' }));

    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    act(() => unmount());

    // A still-running install must not keep the socket or the reader alive.
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(signal?.aborted).toBe(true);
  });

  it('treats a server error event as terminal and keeps its message', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        streamingResponse([
          sse([{ type: 'log', stream: 'stdout', line: 'boom', done: false }]),
          sse([{ type: 'error', error: 'Install log stream failed.', done: true }]),
        ])
      )
    );

    const { result } = renderHook(() => useInstallStream({ runId: 'run-5' }));

    await waitFor(() => expect(result.current.phase).toBe('failed'));
    // Reconnecting would only replay the same failure, and the server's own
    // sentence is the only one that says what actually went wrong.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.streamError).toBe('Install log stream failed.');
    expect(result.current.lines.map((line) => line.text)).toEqual(['boom']);
  });

  it('resets to idle when no run is active', () => {
    const { result } = renderHook(() => useInstallStream({ runId: null }));

    expect(result.current.phase).toBe('idle');
    expect(result.current.lines).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the buffer at a sane default', () => {
    expect(INSTALL_CONSOLE_MAX_LINES).toBeGreaterThan(0);
  });
});
