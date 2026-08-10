/**
 * The disclosure gate, exercised against a real database.
 *
 * The point of these is not that the SQL works. It is that every way an
 * acknowledgement can go stale actually re-prompts, that acknowledging one
 * vendor cannot acknowledge another, and that nothing outside an explicit
 * `acknowledgeExternalDisclosure` call ever satisfies the gate.
 */

import { describe, expect, it } from 'bun:test';
import type {
  ExternalAgentCapabilities,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { getDb } from '../../../../src/db/database';
import {
  acknowledgeExternalDisclosure,
  disclosureContextFingerprint,
  listExternalDisclosures,
  requiresExternalDisclosure,
  revokeExternalDisclosure,
} from '../../../../src/modules/external-agents/application/external-disclosure-gate';
import { insertTestUser } from '../../../support/factories';

const CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  cancellation: true,
};

/** A matrix whose `(default, user)` cell names the account's effective mode. */
function configurations(effectiveDefault: string): readonly ExternalSupportedConfiguration[] {
  return [
    {
      level: 'default',
      routing: 'user',
      supported: true,
      unattended: false,
      vendorId: effectiveDefault,
    },
    { level: 'read-only', routing: 'user', supported: true, unattended: false },
  ];
}

const MANUAL = { capabilities: CAPABILITIES, supportedConfigurations: configurations('default') };

async function freshUser() {
  const user = await insertTestUser();
  return user.id;
}

describe('requiresExternalDisclosure', () => {
  it('requires it when nothing has been acknowledged', async () => {
    const userId = await freshUser();
    expect(await requiresExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb())).toBe(
      true
    );
  });

  it('stops requiring it once acknowledged', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    expect(await requiresExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb())).toBe(
      false
    );
  });

  /**
   * The 2026-08-14 flip, as a test. Nothing about MangoStudio changes and
   * nothing about the CLI's capability flags changes — but what runs without
   * asking goes from "reads only" to "everything, with a classifier reviewing
   * each action", and consent given for the first must not cover the second.
   */
  it('re-prompts when the resolved effective default moves from manual to auto', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());

    const afterFlip = {
      capabilities: CAPABILITIES,
      supportedConfigurations: configurations('auto'),
    };
    expect(
      await requiresExternalDisclosure({ userId, targetId: 'claude' }, afterFlip, getDb())
    ).toBe(true);
  });

  it('re-prompts when the vendor gains a capability the user was never told about', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());

    const wider = {
      capabilities: { ...CAPABILITIES, interactiveApprovals: true },
      supportedConfigurations: configurations('default'),
    };
    expect(await requiresExternalDisclosure({ userId, targetId: 'claude' }, wider, getDb())).toBe(
      true
    );
  });

  it('re-prompts when the stored text version is not the current one', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    await getDb()
      .updateTable('external_agent_disclosures')
      .set({ disclosureVersion: 0 })
      .where('userId', '=', userId)
      .execute();
    expect(await requiresExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb())).toBe(
      true
    );
  });

  /**
   * Every vendor is a different company with different terms. One dialog must
   * never stand in for three.
   */
  it('keeps each vendor separate', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    for (const targetId of ['codex', 'cursor'] as const) {
      expect(await requiresExternalDisclosure({ userId, targetId }, MANUAL, getDb())).toBe(true);
    }
  });

  it('keeps each user separate', async () => {
    const owner = await freshUser();
    const stranger = await freshUser();
    await acknowledgeExternalDisclosure({ userId: owner, targetId: 'claude' }, MANUAL, getDb());
    expect(
      await requiresExternalDisclosure({ userId: stranger, targetId: 'claude' }, MANUAL, getDb())
    ).toBe(true);
  });

  it('requires it again after revocation', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    await revokeExternalDisclosure({ userId, targetId: 'claude' }, getDb());
    expect(await requiresExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb())).toBe(
      true
    );
  });
});

describe('acknowledgeExternalDisclosure', () => {
  it('is idempotent, replacing rather than duplicating', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    await acknowledgeExternalDisclosure({ userId, targetId: 'claude' }, MANUAL, getDb());
    expect(await listExternalDisclosures(userId, getDb())).toHaveLength(1);
  });

  it('lists what a user has acknowledged, for the settings page', async () => {
    const userId = await freshUser();
    await acknowledgeExternalDisclosure(
      { userId, targetId: 'codex' },
      MANUAL,
      getDb(),
      () => 1_700
    );
    expect(await listExternalDisclosures(userId, getDb())).toEqual([
      { targetId: 'codex', disclosureVersion: 1, acknowledgedAt: 1_700 },
    ]);
  });
});

describe('disclosureContextFingerprint', () => {
  it('is stable across calls, so a restart is not a change', () => {
    expect(disclosureContextFingerprint(MANUAL)).toBe(disclosureContextFingerprint(MANUAL));
  });

  it('does not depend on the order of the configuration list', () => {
    const reversed = {
      capabilities: CAPABILITIES,
      supportedConfigurations: [...configurations('default')].reverse(),
    };
    expect(disclosureContextFingerprint(reversed)).toBe(disclosureContextFingerprint(MANUAL));
  });

  /**
   * An unsupported combination describes no risk anyone is exposed to, so it
   * contributes nothing rather than a misleading vendor id.
   */
  it('ignores a default cell the account cannot select', () => {
    const unsupported = {
      capabilities: CAPABILITIES,
      supportedConfigurations: [
        {
          level: 'default',
          routing: 'user',
          supported: false,
          unattended: false,
          vendorId: 'auto',
        },
      ] as readonly ExternalSupportedConfiguration[],
    };
    expect(disclosureContextFingerprint(unsupported)).toContain('default:unknown');
  });
});
