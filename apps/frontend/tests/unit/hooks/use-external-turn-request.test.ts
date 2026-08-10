import { describe, expect, it } from 'vitest';
import { useExternalTurnRequest } from '../../../src/hooks/use-external-turn-request';
import { act, renderHook } from '../../support/harness/render';

describe('useExternalTurnRequest', () => {
  it('keeps a vendor choice for the chat it was made in', () => {
    const { result } = renderHook(() => useExternalTurnRequest('chat-1'));

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'gpt-5-codex' }));
    });
    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, effort: 'high' }));
    });

    expect(result.current.externalTurnRequest).toEqual({ model: 'gpt-5-codex', effort: 'high' });
    expect(result.current.getExternalTurnRequest()).toEqual({
      model: 'gpt-5-codex',
      effort: 'high',
    });
  });

  it('does not carry a vendor choice into the next chat', () => {
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string | null }) => useExternalTurnRequest(chatId),
      { initialProps: { chatId: 'chat-1' as string | null } }
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({
        ...current,
        model: 'gpt-5-codex',
        effort: 'high',
      }));
    });

    rerender({ chatId: 'chat-2' });

    expect(result.current.externalTurnRequest).toEqual({});
    // The send path reads through a ref, so it has to see the reset too — this
    // is the assertion that a turn in the second chat runs on the vendor's own
    // default rather than on a model chosen for the first.
    expect(result.current.getExternalTurnRequest()).toBeUndefined();
  });

  it('starts the next chat from empty rather than from the previous choice', () => {
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string | null }) => useExternalTurnRequest(chatId),
      { initialProps: { chatId: 'chat-1' as string | null } }
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({
        ...current,
        model: 'gpt-5-codex',
        effort: 'high',
      }));
    });

    rerender({ chatId: 'chat-2' });
    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, effort: 'low' }));
    });

    expect(result.current.externalTurnRequest).toEqual({ effort: 'low' });
  });

  it('restores nothing when the first chat is selected again', () => {
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string | null }) => useExternalTurnRequest(chatId),
      { initialProps: { chatId: 'chat-1' as string | null } }
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'gpt-5-codex' }));
    });
    rerender({ chatId: 'chat-2' });
    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'gpt-5' }));
    });
    rerender({ chatId: 'chat-1' });

    // One choice is held, not a per-chat map: the point is that a stale one is
    // never sent, not that switching back is undo.
    expect(result.current.externalTurnRequest).toEqual({});
  });
});
