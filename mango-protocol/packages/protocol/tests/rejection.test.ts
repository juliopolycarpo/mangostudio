import { describe, expect, it } from 'bun:test';
import { rejectionOf } from '../src/testing/rejection';

describe('rejectionOf', () => {
  it('hands back the rejection reason', async () => {
    const reason = new Error('refused');
    expect(await rejectionOf(Promise.reject(reason))).toBe(reason);
  });

  it('fails when the promise resolves instead', async () => {
    await expect(rejectionOf(Promise.resolve({ ok: true }))).rejects.toThrow(
      'expected the promise to reject, but it resolved with {"ok":true}'
    );
  });
});
