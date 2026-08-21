import { describe, expect, it } from 'bun:test';
import { useMutation } from '@tanstack/react-query';
import { appSettingsKeys } from '@/features/settings/app/queries';
import { useAppSettingsSaveStatus } from '@/features/settings/app/use-app-settings-save-status';
import { act, renderHook, waitFor } from '../../../support/harness/render';

/**
 * The indicator never owns the write, so the hook is exercised the way the
 * layout sees it: through a sibling mutation that only shares the key.
 */
function renderSaveStatus(save: () => Promise<unknown>) {
  return renderHook(() => ({
    mutation: useMutation({ mutationKey: appSettingsKeys.save(), mutationFn: save }),
    status: useAppSettingsSaveStatus(),
  }));
}

describe('useAppSettingsSaveStatus', () => {
  it('is idle until a save runs', () => {
    const { result } = renderSaveStatus(() => Promise.resolve({}));

    expect(result.current.status).toBe('idle');
  });

  it('reports saving while the request is open and acknowledges success', async () => {
    let completeSave: (() => void) | undefined;
    const { result } = renderSaveStatus(
      () =>
        new Promise((resolve) => {
          completeSave = () => resolve({});
        })
    );

    act(() => {
      result.current.mutation.mutate();
    });

    await waitFor(() => expect(result.current.status).toBe('saving'));

    act(() => completeSave?.());

    await waitFor(() => expect(result.current.status).toBe('saved'));
  });

  it('reports a failed save', async () => {
    const { result } = renderSaveStatus(() => Promise.reject(new Error('nope')));

    act(() => {
      result.current.mutation.mutate();
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
