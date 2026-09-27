/**
 * What the hub does when it restricts a chat against a runtime that predates
 * runtime-side containment.
 *
 * `pathPolicy` is optional on the wire so a rollout does not have to be atomic,
 * and that tolerance has no failure mode a caller could notice: the older peer
 * accepts the field, ignores it, and answers exactly like a peer that enforced
 * it. The enforcement is what goes missing, silently. So the hub says which
 * environment it is — once per connection, because only an upgrade changes the
 * answer and a line per tool call would bury it.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'node:path';
import { directoryHashDomainVersion } from '@mangostudio/shared/library';
import type {
  RuntimeCapabilityManifest,
  RuntimeReadFileParams,
  RuntimeReadFileResult,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  connectFakeRuntime,
  FakeRuntimeDefinition,
  fixedConsent,
} from '../../../support/fake-runtime-host';
import { TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

const VERSION = 'test';

/** A containment root; the fake runtime never touches a disk, so it need not exist. */
const workdir = '/workspace/project';

let lines: string[];
let close: (() => void | Promise<void>) | undefined;
let previousLogGate: string | undefined;

/**
 * What a current runtime announces about containment: it enforces the path
 * policy, and names the directory-hash domain it hashes with.
 */
const CURRENT_MANIFEST: RuntimeCapabilityManifest = {
  ...TEST_RUNTIME_MANIFEST,
  enforcesPathPolicy: true,
  directoryHashDomain: directoryHashDomainVersion(),
};

/** Answers a read the way a runtime would, so the hub sees a well-formed result. */
function readFile(params: RuntimeReadFileParams): RuntimeReadFileResult {
  return {
    content: 'contents\n',
    path: params.resolvedPath,
    size: 9,
    sha256: '0'.repeat(64),
    totalLines: 1,
    startLine: 1,
    endLine: 1,
    truncated: false,
  };
}

/**
 * A runtime whose manifest is post-processed, so a peer that never declares
 * `enforcesPathPolicy` can be built without a second runtime release. What is
 * asserted is the hub's reaction to the manifest, so no filesystem stands
 * behind it.
 */
async function connect(
  reshapeManifest: (manifest: RuntimeCapabilityManifest) => RuntimeCapabilityManifest
): Promise<RuntimeClient> {
  const definition = new FakeRuntimeDefinition({
    runtimeVersion: VERSION,
    manifest: reshapeManifest(CURRENT_MANIFEST),
    consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
    handlers: { 'fs.read-file': readFile },
  });
  const connection = await connectFakeRuntime(definition, { hubVersion: VERSION });
  close = () => connection.close();
  return new RuntimeClient(connection.hub, undefined, 'env-legacy');
}

/** A peer built before the declaration existed: the key is simply absent. */
function withoutDeclaration(manifest: RuntimeCapabilityManifest): RuntimeCapabilityManifest {
  const { enforcesPathPolicy: _dropped, ...rest } = manifest;
  return rest;
}

function withoutDirectoryHashDomain(
  manifest: RuntimeCapabilityManifest
): RuntimeCapabilityManifest {
  const { directoryHashDomain: _dropped, ...rest } = manifest;
  return rest;
}

function readRestricted(client: RuntimeClient, name: string): Promise<unknown> {
  return client.fs.readFile({
    chatId: 'c1',
    inputPath: name,
    resolvedPath: join(workdir, name),
    pathPolicy: { allowedRoots: [], deniedRoots: [], containmentRoot: workdir },
  });
}

function warnings(): string[] {
  return lines.filter((line) => line.includes('containment_unenforced'));
}

beforeEach(() => {
  lines = [];
  // The unit suite runs with diagnostics gated off so 3000 tests stay readable.
  // This one is about a diagnostic, so it opens the gate and puts it back.
  previousLogGate = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
  spyOn(console, 'warn').mockImplementation((line: string) => {
    lines.push(line);
  });
});

afterEach(async () => {
  await close?.();
  close = undefined;
  mock.restore();
  if (previousLogGate === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousLogGate;
});

describe('a peer that does not declare containment enforcement', () => {
  it('is reported once per connection, however many restricted calls it serves', async () => {
    const client = await connect(withoutDeclaration);

    await readRestricted(client, 'file.txt');
    await readRestricted(client, 'file.txt');
    await readRestricted(client, 'file.txt');

    expect(warnings()).toHaveLength(1);
    const entry = JSON.parse(warnings()[0] ?? '{}');
    expect(entry).toMatchObject({
      level: 'warn',
      event: 'containment_unenforced',
      metadata: { environmentId: 'env-legacy', method: 'fs.read-file' },
    });
  });

  it('is not reported for a chat that was never restricted', async () => {
    const client = await connect(withoutDeclaration);

    await client.fs.readFile({
      chatId: 'c1',
      inputPath: 'file.txt',
      resolvedPath: join(workdir, 'file.txt'),
    });

    expect(warnings()).toHaveLength(0);
  });

  it('answers the enforcement question in the negative rather than not at all', async () => {
    const client = await connect(withoutDeclaration);

    expect(client.enforcesPathPolicy).toBe(false);
  });
});

describe('a peer that declares containment enforcement', () => {
  it('serves restricted calls without a warning', async () => {
    const client = await connect((manifest) => manifest);

    await readRestricted(client, 'file.txt');

    expect(client.enforcesPathPolicy).toBe(true);
    expect(client.directoryHashDomain).toBeGreaterThanOrEqual(2);
    expect(warnings()).toHaveLength(0);
  });
});

describe('a peer that omits the directory-hash domain', () => {
  it('is treated as v2 — the domain that shipped before the field', async () => {
    const client = await connect(withoutDirectoryHashDomain);
    expect(client.directoryHashDomain).toBe(2);
  });
});
