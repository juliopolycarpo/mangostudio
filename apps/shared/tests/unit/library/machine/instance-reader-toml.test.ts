import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLibraryLocation } from '../../../../src/library/host';
import { LibraryCache, readLocationInstances } from '../../../../src/library/machine';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mango-toml-agent-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function readAgent(contents: string) {
  const location = getLibraryLocation('codex-agents');
  if (!location) throw new Error('Expected location codex-agents, received undefined.');
  writeFileSync(join(directory, 'reviewer.toml'), contents);
  const result = await readLocationInstances(location, directory, {
    cache: new LibraryCache(),
    force: true,
  });
  expect(result.unreadableEntries).toEqual([]);
  expect(result.instances).toHaveLength(1);
  return result.instances[0];
}

describe('TOML agent instance reader', () => {
  it('keeps display metadata, dates and the content hash of the original bytes', async () => {
    const contents = `
name = " Mango 🥭 reviewer "
description = " Review a change. "
offset = 1979-05-27T00:32:00.123456789-07:00
local = 1979-05-27T07:32:00.123456789
date = 1979-05-27
time = 07:32:00.123456789

[tools]
enabled = true
`;
    const resource = await readAgent(contents);

    expect(resource?.ref).toEqual({ kind: 'subagent', slug: 'reviewer' });
    expect(resource?.instance).toMatchObject({
      locationId: 'codex-agents',
      valid: true,
      title: 'Mango 🥭 reviewer',
      description: 'Review a change.',
    });
    const expectedHash = new Bun.CryptoHasher('sha256')
      .update('mangostudio/library/file\0')
      .update(contents)
      .digest('hex');
    expect(resource?.instance.contentHash).toBe(expectedHash);
    expect(resource?.instance.sizeBytes).toBe(new TextEncoder().encode(contents).byteLength);
  });

  it('falls back to the resource slug for an empty name and omits an empty description', async () => {
    const resource = await readAgent('name = " "\ndescription = " "\n');

    expect(resource?.instance).toMatchObject({ valid: true, title: 'reviewer' });
    expect(resource?.instance).not.toHaveProperty('description');
  });

  it('keeps invalid-metadata for malformed TOML without leaking the parser message', async () => {
    const resource = await readAgent('name = "reviewer"\n[tools\n');

    expect(resource?.instance).toMatchObject({
      valid: false,
      invalidReason: 'invalid-metadata',
      title: 'reviewer',
    });
  });
});
