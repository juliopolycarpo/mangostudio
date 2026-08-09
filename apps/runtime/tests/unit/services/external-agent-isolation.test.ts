import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSingleUserHostExternalAgentIsolation } from '../../../src/services/external-agents/isolation';

describe('single-user-host identity isolation', () => {
  it('fingerprints the credential home without exposing it', () => {
    const isolation = createSingleUserHostExternalAgentIsolation();

    expect(isolation?.method).toBe('single-user-host');
    expect(isolation?.credentialHomeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('degrades to no attestation when the credential home cannot be read', () => {
    // A Local connection carries file, shell and git access too. An unreadable
    // home may only cost the caller its attestation — and with it external
    // agents — never the whole environment.
    expect(
      createSingleUserHostExternalAgentIsolation(
        join(tmpdir(), 'mangostudio-absent-credential-home')
      )
    ).toBeUndefined();
  });
});
