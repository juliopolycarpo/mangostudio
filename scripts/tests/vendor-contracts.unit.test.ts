/**
 * The two decisions the vendor-contract toolkit makes: what survives a capture,
 * and which differences are worth failing on.
 *
 * Both are load-bearing in ways a passing capture would not reveal. A
 * normalizer that let a value through publishes an operator's session titles
 * into the repository; a diff that called every change fatal would turn a
 * routine vendor release into a red job nobody reads.
 */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractCaptureSkipped } from '../vendor/lib/contract-set';
import { diffCaptures, formatChange, isBreaking } from '../vendor/lib/diff';
import { digestArtifacts, readArtifacts } from '../vendor/lib/manifest';
import { normalizeCapture, serializeCapture } from '../vendor/lib/normalize';

describe('normalizing a capture', () => {
  /**
   * The privacy case, stated against the real payload. `session/list` returns
   * the operator's own session titles and working directories, and `auth
   * status` returns an email address and an organization name.
   */
  it('keeps no value it was not explicitly asked to keep', () => {
    const captured = normalizeCapture({
      sessions: [
        { sessionId: 'dc37af22', cwd: '/home/someone/private', title: 'Shell Command Echo' },
      ],
      email: 'someone@example.com',
      orgName: 'Some Customer Inc',
      loggedIn: true,
    });

    expect(JSON.stringify(captured)).not.toContain('someone');
    expect(JSON.stringify(captured)).not.toContain('Some Customer');
    expect(captured).toEqual({
      email: '<string>',
      loggedIn: '<boolean>',
      orgName: '<string>',
      sessions: [{ cwd: '<string>', sessionId: '<string>', title: '<string>' }],
    });
  });

  it('keeps the values that are themselves the contract', () => {
    const captured = normalizeCapture(
      { protocolVersion: 1, modes: { currentModeId: 'agent', available: [{ id: 'plan' }] } },
      { preserveAt: ['protocolVersion', 'id', 'currentModeId'] }
    );

    expect(captured).toEqual({
      protocolVersion: 1,
      modes: { currentModeId: 'agent', available: [{ id: 'plan' }] },
    });
  });

  it('sorts keys so a vendor reordering its own reply is not drift', () => {
    const left = serializeCapture(normalizeCapture({ b: 1, a: 'x' }));
    const right = serializeCapture(normalizeCapture({ a: 'y', b: 2 }));

    expect(left).toBe(right);
  });

  /**
   * A page with nine sessions and a page with two describe the same contract.
   * Reporting the count as drift would train whoever reads the output to skip
   * it.
   */
  it('reduces an array to its distinct element shapes', () => {
    const captured = normalizeCapture({
      sessions: [{ id: 'a', title: 't' }, { id: 'b', title: 'u' }, { id: 'c' }],
    });

    expect(captured).toEqual({
      sessions: [{ id: '<string>', title: '<string>' }, { id: '<string>' }],
    });
  });

  it('writes a byte-stable file with a trailing newline', () => {
    expect(serializeCapture({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe('classifying drift', () => {
  const committed = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: '<boolean>', promptCapabilities: { image: '<boolean>' } },
  };

  it('finds nothing between two identical captures', () => {
    expect(diffCaptures(committed, structuredClone(committed))).toEqual([]);
  });

  /** The direction that must never be fatal: every vendor here ships weekly. */
  it('treats a new field as additive', () => {
    const changes = diffCaptures(committed, {
      ...committed,
      agentCapabilities: { ...committed.agentCapabilities, somethingNew: '<boolean>' },
    });

    expect(changes.map((change) => change.kind)).toEqual(['added']);
    expect(changes.some(isBreaking)).toBe(false);
  });

  it('treats a field the adapter reads going away as breaking', () => {
    const changes = diffCaptures(committed, { protocolVersion: 1, agentCapabilities: {} });

    expect(changes.filter(isBreaking).map((change) => change.path)).toEqual([
      'agentCapabilities.loadSession',
      'agentCapabilities.promptCapabilities',
    ]);
  });

  it('treats a preserved value moving as breaking', () => {
    const changes = diffCaptures(committed, { ...committed, protocolVersion: 2 });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', path: 'protocolVersion' });
    expect(isBreaking(changes[0] as never)).toBe(true);
  });

  /**
   * The case positional comparison gets catastrophically wrong. Claude's flag
   * list is sorted and 65 entries long, so an option added in the middle would
   * report every following entry as changed — one additive release rendered as
   * a wall of fatal findings.
   */
  it('compares a list of scalars as a set', () => {
    const before = { flags: ['--print', '--resume', '--verbose'] };
    const after = { flags: ['--model', '--print', '--resume', '--verbose'] };
    const changes = diffCaptures(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'added', after: '--model' });
    expect(changes.some(isBreaking)).toBe(false);
  });

  it('still reports a scalar dropping out of that set', () => {
    const changes = diffCaptures({ flags: ['--print', '--verbose'] }, { flags: ['--print'] });

    expect(changes).toHaveLength(1);
    expect(changes.every(isBreaking)).toBe(true);
  });

  /**
   * The same trap one level up, and the one that actually reaches the committed
   * captures: `normalizeCapture` sorts object arrays too, so a Cursor release
   * adding a permission mode whose id sorts before `agent` shifts every index
   * after it. Compared positionally, that additive release reports as two fatal
   * `changed` findings and fails the drift check.
   */
  it('compares a list of object shapes as a set', () => {
    const modes = (ids: readonly string[]) => ({
      availableModes: normalizeCapture(
        ids.map((id) => ({ id, description: 'x', name: 'y' })),
        { preserveAt: ['id'] }
      ),
    });
    const committedModes = modes(['agent', 'ask', 'plan']);
    const changes = diffCaptures(committedModes, modes(['agent', 'architect', 'ask', 'plan']));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'added' });
    expect(changes.some(isBreaking)).toBe(false);
  });

  /**
   * A field disappearing from inside an element is a *different shape*, so the
   * set reports it as the old one removed and the new one added. The `removed`
   * half is what matters: it is breaking, so the check still fails, which is
   * the only guarantee the positional version was ever buying.
   */
  it('still reports an object shape the vendor stopped producing', () => {
    const changes = diffCaptures(
      { sessions: [{ cwd: '<string>', sessionId: '<string>' }] },
      { sessions: [{ sessionId: '<string>' }] }
    );

    expect(changes.map((change) => change.kind).sort()).toEqual(['added', 'removed']);
    expect(changes.some(isBreaking)).toBe(true);
  });

  it('renders a change as one readable line', () => {
    expect(
      formatChange({ kind: 'changed', path: 'protocolVersion', before: '1', after: '2' })
    ).toBe('  changed protocolVersion: 1 → 2');
  });
});

describe('artifact checksums', () => {
  /**
   * The whole point of committing a checksum: telling "I regenerated it and
   * nothing changed" apart from "I never ran it".
   */
  it('is stable for the same bytes and moves for different ones', () => {
    const first = digestArtifacts(new Map([['a.json', '{}\n']]));
    const again = digestArtifacts(new Map([['a.json', '{}\n']]));
    const changed = digestArtifacts(new Map([['a.json', '{"a":1}\n']]));

    expect(first.checksum).toBe(again.checksum);
    expect(changed.checksum).not.toBe(first.checksum);
  });

  it('moves when a file is renamed but its bytes are not', () => {
    const before = digestArtifacts(new Map([['a.json', '{}\n']]));
    const after = digestArtifacts(new Map([['b.json', '{}\n']]));

    expect(after.checksum).not.toBe(before.checksum);
  });
});

describe('reading a committed contract directory', () => {
  /**
   * A directory that could not be read must not come back as an empty contract.
   * `checkSet` would diff a real capture against nothing, report every artifact
   * as `added`, and pass the run as additive — a failed read announcing itself
   * as a healthy vendor.
   */
  it('fails rather than reporting a missing directory as an empty contract', async () => {
    const absent = join(tmpdir(), `vendor-contract-absent-${Date.now()}`);

    await expect(readArtifacts(absent)).rejects.toThrow();
  });

  /** Recording a set for the first time is the one caller absence answers. */
  it('reads a missing directory as empty only when the caller asked for that', async () => {
    const absent = join(tmpdir(), `vendor-contract-absent-${Date.now()}`);

    expect(await readArtifacts(absent, { allowMissing: true })).toEqual(new Map());
  });

  it('reads a real tree keyed on the directory-relative path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vendor-contract-'));
    await mkdir(join(directory, 'nested'), { recursive: true });
    await writeFile(join(directory, 'a.json'), '{}\n');
    await writeFile(join(directory, 'nested', 'b.json'), '{"b":1}\n');
    await writeFile(join(directory, 'manifest.json'), '{"set":"x"}\n');

    const artifacts = await readArtifacts(directory);

    // The manifest describes the capture rather than being part of it.
    expect([...artifacts.keys()]).toEqual(['a.json', 'nested/b.json']);
    await rm(directory, { recursive: true, force: true });
  });
});

/**
 * A CI runner has no vendor credentials, which is the normal case rather than
 * a broken one. What it must never do is record a *smaller* contract than the
 * real one — a signed-out `claude auth status` answers with three fields
 * instead of seven, and committing that would read as the vendor removing
 * four.
 */
describe('a capture that could only see part of a contract', () => {
  const committed = new Map([
    ['cli-surface.json', '{"flags":["--print"]}\n'],
    ['auth-status.json', '{"email":"<string>","loggedIn":"<boolean>"}\n'],
  ]);

  it('reports a skip distinctly from a failure', () => {
    const skip = new ContractCaptureSkipped('cursor-agent is signed out.');

    expect(skip).toBeInstanceOf(Error);
    expect(skip.name).toBe('ContractCaptureSkipped');
    // The distinction the caller branches on: a plain Error stops the run, a
    // skip means this machine cannot answer and should say so.
    expect(new Error('boom')).not.toBeInstanceOf(ContractCaptureSkipped);
  });

  it('leaves the uncapturable artifact out of the comparison entirely', () => {
    const compared = new Map(committed);
    compared.delete('auth-status.json');

    // Diffing what was captured against the full committed set would report
    // the credentialed artifact as removed, which is a fabricated breakage.
    expect([...compared.keys()]).toEqual(['cli-surface.json']);
    expect(
      diffCaptures(JSON.parse(compared.get('cli-surface.json') ?? '{}'), { flags: ['--print'] })
    ).toEqual([]);
  });
});
