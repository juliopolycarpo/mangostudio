import { afterEach, describe, expect, test } from 'bun:test';

import { cursorSidecarPackageTreeErrors } from '../lib/cursor-sidecar';
import {
  createCursorSmokeSidecarFixture,
  runCursorSmokeSidecarProtocol,
} from '../lib/cursor-smoke-sidecar-fixture';

describe('cursor smoke sidecar fixture', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test('stub tree satisfies cursor sidecar package layout checks', () => {
    const fixture = createCursorSmokeSidecarFixture('linux-x64');
    cleanup = fixture.cleanup;

    expect(cursorSidecarPackageTreeErrors(fixture.rootDir, '@cursor/sdk-linux-x64')).toEqual([]);
  });

  test('validate_api_key returns a canned auth rejection over the sidecar protocol', async () => {
    const fixture = createCursorSmokeSidecarFixture('linux-x64');
    cleanup = fixture.cleanup;

    const result = await runCursorSmokeSidecarProtocol(fixture.sidecarScriptPath, {
      type: 'validate_api_key',
      apiKey: 'smoke-invalid-cursor-key',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toEqual([
      {
        type: 'error',
        message: 'Cursor API key rejected',
        content: 'Cursor API key rejected',
        status: 401,
        isRetryable: false,
        retryable: false,
        done: true,
      },
    ]);
  });
});
