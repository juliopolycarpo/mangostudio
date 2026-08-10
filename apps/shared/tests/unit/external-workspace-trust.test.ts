/**
 * The workspace-trust record, and every way it must fail closed.
 *
 * The single invariant behind all of it: absence is never consent. A missing
 * row, a malformed row, a row for another environment and a row from an older
 * disclosure version all mean "ask again", because the alternative is a vendor
 * loading a repository's own instructions on the strength of a record that says
 * nothing.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeAppSettings } from '@mangostudio/shared/app-settings';
import {
  EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES,
  EXTERNAL_WORKSPACE_TRUST_TARGETS,
  EXTERNAL_WORKSPACE_TRUST_VERSION,
  type ExternalWorkspaceTrust,
  needsWorkspaceTrust,
  withWorkspaceTrust,
} from '@mangostudio/shared/external-agents';

const KEY = {
  targetId: 'cursor',
  environmentId: 'local',
  workspacePath: '/home/dev/repo',
} as const;

describe('which targets need a workspace trusted', () => {
  it('covers the vendor whose session loads workspace configuration', () => {
    expect(EXTERNAL_WORKSPACE_TRUST_TARGETS).toEqual(['cursor']);
  });

  it('never asks for a target that has not declared what it loads', () => {
    expect(needsWorkspaceTrust([], { ...KEY, targetId: 'codex' })).toBe(false);
    expect(needsWorkspaceTrust([], { ...KEY, targetId: 'claude' })).toBe(false);
  });
});

describe('needsWorkspaceTrust', () => {
  it('asks when nothing is recorded', () => {
    expect(needsWorkspaceTrust([], KEY)).toBe(true);
  });

  it('stops asking once the exact workspace is trusted', () => {
    const entries = withWorkspaceTrust([], KEY, 1_000);
    expect(needsWorkspaceTrust(entries, KEY)).toBe(false);
  });

  it('asks again for a different directory, environment or vendor', () => {
    const entries = withWorkspaceTrust([], KEY, 1_000);

    expect(needsWorkspaceTrust(entries, { ...KEY, workspacePath: '/home/dev/other' })).toBe(true);
    expect(needsWorkspaceTrust(entries, { ...KEY, environmentId: 'laptop' })).toBe(true);
    // A sibling directory must not be covered by its parent's grant.
    expect(needsWorkspaceTrust(entries, { ...KEY, workspacePath: '/home/dev/repo/packages' })).toBe(
      true
    );
  });

  it('asks again when the disclosure text has moved on', () => {
    const stale: ExternalWorkspaceTrust[] = [
      { ...KEY, version: EXTERNAL_WORKSPACE_TRUST_VERSION + 1, acceptedAt: 1_000 },
    ];
    expect(needsWorkspaceTrust(stale, KEY)).toBe(true);
  });
});

describe('withWorkspaceTrust', () => {
  it('replaces an earlier grant for the same workspace rather than duplicating it', () => {
    const first = withWorkspaceTrust([], KEY, 1_000);
    const second = withWorkspaceTrust(first, KEY, 2_000);

    expect(second).toHaveLength(1);
    expect(second[0]?.acceptedAt).toBe(2_000);
  });

  it('drops the oldest grant rather than growing without bound', () => {
    let entries: ExternalWorkspaceTrust[] = [];
    for (let index = 0; index <= EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES; index += 1) {
      entries = withWorkspaceTrust(entries, { ...KEY, workspacePath: `/repo/${index}` }, index);
    }

    expect(entries).toHaveLength(EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES);
    // Evicting the oldest re-prompts for a workspace nobody has touched, which
    // is the safe direction to fail in.
    expect(needsWorkspaceTrust(entries, { ...KEY, workspacePath: '/repo/0' })).toBe(true);
    expect(
      needsWorkspaceTrust(entries, {
        ...KEY,
        workspacePath: `/repo/${EXTERNAL_WORKSPACE_TRUST_MAX_ENTRIES}`,
      })
    ).toBe(false);
  });
});

describe('normalizing stored settings', () => {
  it('starts empty when nothing was ever saved', () => {
    const settings = normalizeAppSettings({});
    expect(settings.externalAgentSettings.workspaceTrust).toEqual([]);
  });

  it('keeps a well-formed row and drops everything else', () => {
    const good = { ...KEY, version: EXTERNAL_WORKSPACE_TRUST_VERSION, acceptedAt: 1_000 };
    const settings = normalizeAppSettings({
      externalAgentSettings: {
        disclosures: {},
        workspaceTrust: [
          good,
          { ...good, targetId: 'not-a-vendor' },
          { ...good, workspacePath: '' },
          { ...good, environmentId: 'x'.repeat(200) },
          { ...good, version: 0 },
          { ...good, acceptedAt: -1 },
          'not an object',
        ],
      },
    });

    expect(settings.externalAgentSettings.workspaceTrust).toEqual([good]);
  });

  it('keeps the grants when the disclosures beside them are missing', () => {
    // Two independent records of two different questions: a settings row that
    // never stored a disclosure must not read as consent withdrawn.
    const good = { ...KEY, version: EXTERNAL_WORKSPACE_TRUST_VERSION, acceptedAt: 1_000 };
    const settings = normalizeAppSettings({
      externalAgentSettings: { workspaceTrust: [good] },
    });

    expect(settings.externalAgentSettings.workspaceTrust).toEqual([good]);
    expect(settings.externalAgentSettings.disclosures).toEqual({});
  });

  it('reads a non-array as no grants at all', () => {
    const settings = normalizeAppSettings({
      externalAgentSettings: { disclosures: {}, workspaceTrust: { '/repo': true } },
    });
    expect(settings.externalAgentSettings.workspaceTrust).toEqual([]);
  });
});
