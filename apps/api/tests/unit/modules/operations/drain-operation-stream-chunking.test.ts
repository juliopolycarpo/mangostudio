import { describe, expect, it } from 'bun:test';

import { SSE_FRAME_MAX_CHARS } from '@mangostudio/shared/streaming';

import { getDb } from '../../../../src/db/database';
import { drainOperationStream } from '../../../../src/modules/operations/application/drain-operation-stream';
import {
  claimOperation,
  readOperation,
} from '../../../../src/modules/operations/application/product-operation';
import { insertTestUser } from '../../../support/factories';

const encoder = new TextEncoder();
let operationCounter = 0;

/** The receipt `drainOperationStream` settles for a body delivered in the given pieces. */
async function settle(
  pieces: readonly Uint8Array[],
  external = false
): Promise<{ state: string; messageId: string | null }> {
  const db = getDb();
  const user = await insertTestUser();
  operationCounter += 1;
  const operationId = `drain-chunking-${operationCounter}`;
  await claimOperation(db, user.id, operationId, 'submit-turn', { prompt: 'Hello' });
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[next];
      next += 1;
      if (piece === undefined) controller.close();
      else controller.enqueue(piece);
    },
  });

  await drainOperationStream(new Response(body), db, user.id, operationId, external);

  const receipt = await readOperation(db, user.id, operationId);
  return { state: receipt?.state ?? 'missing', messageId: receipt?.messageId ?? null };
}

function piecesOf(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    pieces.push(bytes.subarray(offset, offset + size));
  }
  return pieces;
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const COMPLETED_TURN = `${
  frame({ type: 'assistant_message_id', messageId: 'assistant-1' }) +
  frame({ type: 'text', text: 'héllo 🥭 中文', done: false })
}: keepalive\n\n${frame({ type: 'done', done: true, messageId: 'assistant-2' })}`;

describe('drainOperationStream reads of a frame split across chunks', () => {
  it.each([1, 2, 3, 7, 16, 4096])(
    'settles a completed turn the same with %d-byte reads as with one read',
    async (size) => {
      const whole = await settle([encoder.encode(COMPLETED_TURN)]);

      expect(whole).toEqual({ state: 'completed', messageId: 'assistant-2' });
      expect(await settle(piecesOf(COMPLETED_TURN, size))).toEqual(whole);
    }
  );

  it('settles an error frame whose blank-line terminator is split across reads as failed', async () => {
    const text =
      frame({ type: 'error', error: 'provider failed' }) + frame({ type: 'done', done: true });
    const cut = text.indexOf('\n\n') + 1;
    const pieces = [encoder.encode(text.slice(0, cut)), encoder.encode(text.slice(cut))];

    expect((await settle(pieces)).state).toBe('failed');
  });

  it('does not act on a final frame whose blank-line terminator never arrives', async () => {
    const text = `${frame({ type: 'text', text: 'x' })}data: {"type":"done","done":true}\n`;

    expect((await settle(piecesOf(text, 5))).state).toBe('unresolved');
  });

  // The reader used to append every read to one string and search it again, so a
  // frame spanning n reads cost O(frame * n): 1 MiB in 16-byte reads took
  // several seconds. The bound separates linear from quadratic; it is no benchmark.
  it('settles a 1 MiB frame delivered in 16-byte reads within 2500 ms', async () => {
    const text =
      frame({ type: 'text', text: 'a'.repeat(1024 * 1024), done: false }) +
      frame({ type: 'done', done: true, messageId: 'big-answer' });
    const pieces = piecesOf(text, 16);

    const startedAt = performance.now();
    const receipt = await settle(pieces);
    const elapsedMs = performance.now() - startedAt;

    expect(receipt).toEqual({ state: 'completed', messageId: 'big-answer' });
    expect(elapsedMs).toBeLessThan(2500);
  });

  it(`settles unresolved when one frame outgrows ${SSE_FRAME_MAX_CHARS} characters`, async () => {
    const oversized = `data: ${'a'.repeat(SSE_FRAME_MAX_CHARS)}`;
    const pieces = [encoder.encode(oversized), encoder.encode(frame({ type: 'done', done: true }))];

    expect((await settle(pieces)).state).toBe('unresolved');
  });

  it('settles unresolved when the body ends right after a done frame and the start of an oversized one', async () => {
    // One piece holds the done frame and the oversized tail, then EOF. `push`
    // returns the done frame; only the end-of-stream `finish` raises the refusal.
    const piece = encoder.encode(
      `${frame({ type: 'done', done: true })}data: ${'a'.repeat(SSE_FRAME_MAX_CHARS)}`
    );

    expect((await settle([piece])).state).toBe('unresolved');
  });
});
