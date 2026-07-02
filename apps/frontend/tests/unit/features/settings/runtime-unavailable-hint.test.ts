import { en } from '@mangostudio/shared/i18n';
import { describe, expect, it } from 'vitest';
import { formatConnectorRuntimeUnavailableHint } from '../../../../src/features/settings/connectors/lib/runtime-unavailable-hint';

describe('formatConnectorRuntimeUnavailableHint', () => {
  it('formats Cursor SDK package integrity failures', () => {
    expect(
      formatConnectorRuntimeUnavailableHint(
        'cursor.sdk_missing',
        { sidecarPath: '/app/cursor-sidecar/run-agent.mjs' },
        en.settings.connectors
      )
    ).toContain('Cursor SDK package is missing');

    expect(
      formatConnectorRuntimeUnavailableHint(
        'cursor.sdk_incomplete',
        { sidecarPath: '/app/cursor-sidecar/run-agent.mjs' },
        en.settings.connectors
      )
    ).toContain('Cursor SDK package is incomplete');
  });

  it('formats missing Cursor native runtime packages', () => {
    expect(
      formatConnectorRuntimeUnavailableHint(
        'cursor.native_runtime_missing',
        { packageName: '@cursor/sdk-linux-x64' },
        en.settings.connectors
      )
    ).toBe(
      'Cursor native runtime package @cursor/sdk-linux-x64 is missing. Reinstall MangoStudio.'
    );
  });

  it('exposes the mango doctor hint in connector messages', () => {
    expect(en.settings.connectors.cursorRuntimeDoctorHint).toContain('mango doctor');
  });
});
