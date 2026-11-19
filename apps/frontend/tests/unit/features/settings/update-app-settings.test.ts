import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';

import { getTabWriterId } from '@/lib/realtime/writer-id';

const mockPut = jest.fn();

void mock.module('../../../../src/lib/api-client', () => ({
  client: { api: { settings: { app: { put: mockPut } } } },
}));

// Imported after the mock so the request goes to the fake client.
const { updateAppSettings } = await import('../../../../src/features/settings/app/api');

describe('updateAppSettings', () => {
  beforeEach(() => {
    mockPut.mockReset();
    mockPut.mockResolvedValue({ data: { ...DEFAULT_APP_SETTINGS, revision: '"r2"' }, error: null });
  });

  it('names this tab as the writer so it can recognise its own realtime echo', async () => {
    await updateAppSettings({ thinkingEnabled: false });

    expect(mockPut.mock.calls[0]?.[1]).toEqual({
      headers: { 'x-mangostudio-writer-id': getTabWriterId() },
    });
  });

  it('sends the writer id next to the revision precondition', async () => {
    await updateAppSettings({ thinkingEnabled: false }, '"r1"');

    expect(mockPut.mock.calls[0]?.[1]).toEqual({
      headers: { 'x-mangostudio-writer-id': getTabWriterId(), 'if-match': '"r1"' },
    });
  });
});
