import { describe, expect, it } from 'bun:test';
import { probeCursorDoctorRuntime } from '../../../src/cli/cursor-doctor-probe';
import { CursorApiError } from '../../../src/services/providers/cursor/client';

describe('probeCursorDoctorRuntime', () => {
  it('treats auth rejection as a healthy chain', async () => {
    const result = await probeCursorDoctorRuntime({
      validateApiKey: () =>
        Promise.reject(
          new CursorApiError('Cursor rejected the API key.', {
            cause: { status: 401 },
          })
        ),
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('auth rejected probe key');
  });

  it('fails when the sidecar cannot validate the key', async () => {
    const result = await probeCursorDoctorRuntime({
      validateApiKey: () => Promise.reject(new CursorApiError('Sidecar spawn failed.')),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Sidecar spawn failed');
  });
});
