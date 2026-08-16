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
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectInProcessRuntime,
  createLocalRuntimeManifest,
  createRuntimeMethodHandlers,
  RuntimeHost,
} from '@mangostudio/runtime';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

const VERSION = 'test';

let workdir: string;
let lines: string[];
let close: (() => void | Promise<void>) | undefined;
let previousLogGate: string | undefined;

/**
 * A Local runtime whose manifest is post-processed, so a peer that never
 * declares `enforcesPathPolicy` can be built without a second runtime release.
 */
async function connect(
  reshapeManifest: (manifest: RuntimeCapabilityManifest) => RuntimeCapabilityManifest
): Promise<RuntimeClient> {
  let host: RuntimeHost | undefined;
  const registry = createRuntimeMethodHandlers({
    runtimeVersion: VERSION,
    emit: (event) => host?.emit(event),
  });
  host = new RuntimeHost({
    runtimeVersion: VERSION,
    manifest: reshapeManifest(createLocalRuntimeManifest()),
    handlers: registry.handlers,
    onClose: () => void registry.close(),
  });
  const connection = await connectInProcessRuntime(host, { hubVersion: VERSION });
  close = () => connection.close();
  return new RuntimeClient(connection.client, undefined, 'env-legacy');
}

/** A peer built before the declaration existed: the key is simply absent. */
function withoutDeclaration(manifest: RuntimeCapabilityManifest): RuntimeCapabilityManifest {
  const { enforcesPathPolicy: _dropped, ...rest } = manifest;
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

beforeEach(async () => {
  lines = [];
  // The unit suite runs with diagnostics gated off so 3000 tests stay readable.
  // This one is about a diagnostic, so it opens the gate and puts it back.
  previousLogGate = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
  spyOn(console, 'warn').mockImplementation((line: string) => {
    lines.push(line);
  });
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'unenforced-containment-')));
  await Bun.write(join(workdir, 'file.txt'), 'contents\n');
});

afterEach(async () => {
  await close?.();
  close = undefined;
  mock.restore();
  if (previousLogGate === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousLogGate;
  rmSync(workdir, { recursive: true, force: true });
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
    expect(warnings()).toHaveLength(0);
  });
});
