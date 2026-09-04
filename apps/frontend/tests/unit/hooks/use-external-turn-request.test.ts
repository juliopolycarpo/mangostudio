import { describe, expect, it } from 'bun:test';
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

describe('the durable selection behind the session one', () => {
  it('shows what the chat stored when this session has chosen nothing', () => {
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', { stored: { model: 'opus', effort: 'high' } })
    );

    expect(result.current.externalTurnRequest).toEqual({ model: 'opus', effort: 'high' });
  });

  /**
   * The stored value is for the composer to *show*, never for a send to carry.
   *
   * The hub already resolves chat → settings default on its own, so putting a
   * value nobody picked this session on the wire would only create a second
   * source of truth — and would pin a model the settings default was later
   * changed away from.
   */
  it('sends nothing when the session made no choice of its own', () => {
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', { stored: { model: 'opus' } })
    );

    expect(result.current.getExternalTurnRequest()).toBeUndefined();
  });

  /**
   * The trap this pins: reading a default must not write one.
   *
   * If merely opening a chat persisted whatever the settings default resolved
   * to, every chat opened after setting a default would silently adopt it, and
   * changing that default later would stop reaching those chats.
   */
  it('persists nothing until the user picks something', () => {
    const persisted: unknown[] = [];
    renderHook(() =>
      useExternalTurnRequest('chat-1', {
        stored: { model: 'opus' },
        persist: (selection) => persisted.push(selection),
      })
    );

    expect(persisted).toEqual([]);
  });

  it('persists the pair on an explicit pick', () => {
    const persisted: unknown[] = [];
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', {
        stored: { model: 'opus', effort: 'high' },
        persist: (selection) => persisted.push(selection),
      })
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'sonnet' }));
    });

    // Written as a pair, matching the repository: an effort belongs to the
    // model it was chosen for, so a model change must not leave the old one.
    expect(persisted).toEqual([{ model: 'sonnet', effort: 'high' }]);
    expect(result.current.getExternalTurnRequest()).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('does not persist into a chat that is no longer the active one', () => {
    const persisted: unknown[] = [];
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: string | null }) =>
        useExternalTurnRequest(chatId, { persist: (selection) => persisted.push(selection) }),
      { initialProps: { chatId: 'chat-1' as string | null } }
    );

    rerender({ chatId: null });
    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'sonnet' }));
    });

    expect(persisted).toEqual([]);
  });
});

describe('a pick that changes both fields at once', () => {
  /**
   * The composer's own shape, and the regression this pins.
   *
   * `ExternalComposerControls` invalidates the effort in the same event that
   * changes the model — the effort vocabulary belongs to the model — so the
   * hook is called twice with no render between the calls. Applying the second
   * one to the render's copy of the state would apply it to the pair from
   * before the first, and the write that lands last would be the one that never
   * saw the model the user just chose.
   */
  it('persists the model the user just picked, not the one it replaced', () => {
    const persisted: unknown[] = [];
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', {
        stored: { model: 'opus', effort: 'high' },
        persist: (selection) => persisted.push(selection),
      })
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'sonnet' }));
      result.current.setExternalTurnRequest((current) => ({ ...current, effort: undefined }));
    });

    expect(persisted.at(-1)).toEqual({ model: 'sonnet' });
    expect(result.current.externalTurnRequest).toEqual({ model: 'sonnet' });
  });

  /** The wire agrees with the composer: no effort chosen for the new model. */
  it('does not send the previous model’s effort', () => {
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', { stored: { model: 'opus', effort: 'high' } })
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: 'sonnet' }));
      result.current.setExternalTurnRequest((current) => ({ ...current, effort: undefined }));
    });

    expect(result.current.getExternalTurnRequest()).toEqual({ model: 'sonnet' });
  });

  /**
   * Clearing is a choice, and it has to be expressible.
   *
   * A per-field fallback to the stored pair cannot tell "left alone" from "set
   * back to the vendor's default", so it reads the stored model back and writes
   * it straight out again — leaving the picker unable to return to Default.
   */
  it('lets the user clear a stored model back to the vendor default', () => {
    const persisted: unknown[] = [];
    const { result } = renderHook(() =>
      useExternalTurnRequest('chat-1', {
        stored: { model: 'opus' },
        persist: (selection) => persisted.push(selection),
      })
    );

    act(() => {
      result.current.setExternalTurnRequest((current) => ({ ...current, model: undefined }));
    });

    expect(persisted).toEqual([{}]);
    expect(result.current.externalTurnRequest).toEqual({});
    expect(result.current.getExternalTurnRequest()).toBeUndefined();
  });
});
