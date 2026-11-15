/**
 * The one unavailable sentence that names a build.
 *
 * Asserted as a pure function rather than through a rendered row: the selector
 * and the send-refusal path reach it with and without a version in hand, and
 * what matters is that neither ever prints the raw placeholder.
 */

import { describe, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';

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

  it('says a refused launch in both shipped languages without a build placeholder', () => {
    for (const messages of [en, ptBR]) {
      const text = externalUnavailableText('launch-refused', messages);
      expect(text).toBe(messages.externalAgents.unavailable['launch-refused']);
      expect(text).not.toContain('{version}');
    }
  });

  it('prints a version containing replacement patterns literally', () => {
    // `String.replace` reads `$&` and `$1` in a replacement string; a version is data, not a pattern.
    const text = externalUnavailableText('version-unsupported', en, '$& $1 $$');
    expect(text).toBe(
      en.externalAgents.unavailable['version-unsupported'].replace('{version}', () => '$& $1 $$')
    );
  });
});
