/**
 * useUpgradeStream: the pre-stream refusal path, stage/output/done ordering,
 * and the one outcome the brief calls out specifically — a body that ends
 * without ever sending a `done` event must read as failed, not as a silent
 * success.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { UpgradeStreamEvent } from '@mangostudio/shared/updates';
import { act } from '@testing-library/react';
import {
  UPGRADE_CONSOLE_MAX_LINES,
  useUpgradeStream,
} from '../../../../src/features/environments/machine/hooks/use-upgrade-stream';
import { renderHook, waitFor } from '../../../support/harness/render';

function sse(events: readonly UpgradeStreamEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

interface StreamingResponseOptions {
  readonly onCancel?: () => void;
}

/** A 200 response whose body streams `chunks`, matching a real upgrade run. */
function streamingResponse(
  chunks: readonly string[],
  { onCancel }: StreamingResponseOptions = {}
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index] as string));
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200 });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DONE_EVENT: UpgradeStreamEvent = {
  type: 'done',
  done: true,
  outcome: 'upgraded',
  installedVia: { manager: 'self-managed', channel: 'stable', executable: '/opt/mango/bin' },
  currentVersion: '0.2.0',
  exitCode: 0,
};

describe('useUpgradeStream', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('starts idle and sends no request until start() is called', () => {
    const { result } = renderHook(() => useUpgradeStream());
    expect(result.current.phase).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads stage and output events in order, then the done report', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        sse([
          { type: 'stage', stage: 'resolve', done: false },
          { type: 'stage', stage: 'download', done: false },
          { type: 'output', stream: 'stdout', line: 'fetching release', done: false },
        ]),
        sse([DONE_EVENT]),
      ])
    );

    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({ channel: 'stable' }));

    await waitFor(() => expect(result.current.phase).toBe('done'));
    expect(result.current.stages.map((entry) => entry.stage)).toEqual(['resolve', 'download']);
    expect(result.current.lines.map((line) => line.text)).toEqual(['fetching release']);
    expect(result.current.report?.outcome).toBe('upgraded');
    expect(result.current.report?.currentVersion).toBe('0.2.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/machine/upgrade');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('treats a 409 JSON body as a refusal without reading a stream', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: 'A package manager owns this install.',
        code: 'UNSUPPORTED',
        details: { reason: 'package-manager', command: 'npm update -g mangostudio' },
      })
    );

    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({}));

    await waitFor(() => expect(result.current.phase).toBe('refused'));
    expect(result.current.refusal?.reason).toBe('package-manager');
    expect(result.current.refusal?.command).toBe('npm update -g mangostudio');
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.report).toBeNull();
  });

  it('treats a 403 loopback-guard body as a refusal too', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: 'not local',
        code: 'PERMISSION_DENIED',
        details: { reasons: 'client-not-loopback' },
      })
    );

    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({}));

    await waitFor(() => expect(result.current.phase).toBe('refused'));
    expect(result.current.refusal?.reasons).toEqual(['client-not-loopback']);
  });

  it('reads as failed when the body ends without ever sending a done event', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        sse([
          { type: 'stage', stage: 'resolve', done: false },
          { type: 'output', stream: 'stdout', line: 'still going', done: false },
        ]),
        // The body simply closes here — no `done`, no `error`. A dropped
        // connection, not a completed upgrade.
      ])
    );

    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({ channel: 'stable' }));

    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.report).toBeNull();
    // The lines already read stay visible; only the outcome reads as failed.
    expect(result.current.lines.map((line) => line.text)).toEqual(['still going']);
  });

  it('surfaces a top-level SSEErrorEvent as failed with its own message', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([sse([{ type: 'error', error: 'Verification failed.', done: true }])])
    );

    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({ channel: 'stable' }));

    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.streamError).toBe('Verification failed.');
  });

  it('tears the reader down and aborts the fetch on unmount', async () => {
    const onCancel = jest.fn();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              onCancel();
            },
          }),
          { status: 200 }
        )
      );
    });

    const { result, unmount } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({ channel: 'stable' }));

    await waitFor(() => expect(result.current.phase).toBe('streaming'));
    act(() => unmount());

    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('ignores a second start() while one is already in flight', async () => {
    fetchMock.mockResolvedValue(streamingResponse([sse([DONE_EVENT])]));

    const { result } = renderHook(() => useUpgradeStream());
    act(() => {
      result.current.start({ channel: 'stable' });
      result.current.start({ channel: 'stable' });
    });

    await waitFor(() => expect(result.current.phase).toBe('done'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resets to idle', async () => {
    fetchMock.mockResolvedValue(streamingResponse([sse([DONE_EVENT])]));
    const { result } = renderHook(() => useUpgradeStream());
    act(() => result.current.start({ channel: 'stable' }));
    await waitFor(() => expect(result.current.phase).toBe('done'));

    act(() => result.current.reset());
    expect(result.current.phase).toBe('idle');
    expect(result.current.report).toBeNull();
  });

  it('caps the buffer at a sane default', () => {
    expect(UPGRADE_CONSOLE_MAX_LINES).toBeGreaterThan(0);
  });
});
