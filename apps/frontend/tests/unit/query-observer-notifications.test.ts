import { describe, expect, it } from 'bun:test';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '../support/harness/render';

describe('React Query observer notifications', () => {
  it('rerenders a query observer after an external cache write', async () => {
    const { result } = renderHook(() => {
      const query = useQuery({
        queryKey: ['observer-notification'],
        queryFn: () => Promise.resolve('initial'),
      });
      return { data: query.data, queryClient: useQueryClient() };
    });

    await waitFor(() => expect(result.current.data).toBe('initial'));

    act(() => {
      result.current.queryClient.setQueryData(['observer-notification'], 'updated');
    });

    await waitFor(() => expect(result.current.data).toBe('updated'));
  });
});
