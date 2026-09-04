/**
 * The one unavailable sentence that names a build.
 *
 * Asserted as a pure function rather than through a rendered row: the selector
 * and the send-refusal path reach it with and without a version in hand, and
 * what matters is that neither ever prints the raw placeholder.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { externalUnavailableText } from '@/features/external-agents/useExternalAgents';

describe('externalUnavailableText', () => {
  it("names the build when the caller has the adapter's pin", () => {
    expect(externalUnavailableText('version-unsupported', en, '2.1.260')).toContain('2.1.260');
  });

  it('falls back to the unknown-version wording rather than printing the placeholder', () => {
    // A send refusal carries only the reason, so this is the common path.
    const text = externalUnavailableText('version-unsupported', en);
    expect(text).not.toContain('{version}');
    expect(text).toContain(en.externalAgents.selector.unknownVersion);
  });

  it('leaves a reason whose copy names no build untouched', () => {
    expect(externalUnavailableText('signed-out', en)).toBe(
      en.externalAgents.unavailable['signed-out']
    );
  });
});
