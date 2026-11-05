import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { GhCommandResult } from './canary-github';
import {
  type CanaryReleaseClient,
  type CanaryReleaseExpectation,
  type CanaryReleasePublication,
  verifyCanaryReleasePublication,
} from './canary-release';
import { type CanaryVisibilityOptions, CanaryVisibilityWindow } from './canary-visibility';

/** Local approved assets; reads and upload paths refer to the same staged files. */
export interface CanaryReleaseAssetStore {
  read(name: string): Promise<Uint8Array>;
  path(name: string): string;
}

/** Controlled GitHub mutation boundary, retaining the audited read contract. */
export interface CanaryReleasePublisherClient extends CanaryReleaseClient {
  writeCommand(args: readonly string[]): GhCommandResult | Promise<GhCommandResult>;
}

interface CanaryReleasePublishResult {
  readonly outcome: 'noop' | 'published';
  readonly releaseId: number | null;
  readonly uploaded: readonly string[];
  readonly createdDraft: boolean;
}

/**
 * Resume a canary release using an authenticated expected asset map and approved
 * local bytes. The caller authenticates the map's builder/publisher evidence;
 * this function checks local and remote identity before every external phase.
 * Public complete releases are no-ops. Matching draft assets are retained,
 * missing assets are uploaded without clobber, then the exact draft is published.
 * Post-write audits share at most 60 seconds of retry delays for visibility.
 * A failed command may have external effects: rerun with the same approved bytes.
 *
 * @example
 * await publishVerifiedCanaryRelease(expected, approvedFiles, github);
 */
export async function publishVerifiedCanaryRelease(
  expected: CanaryReleaseExpectation,
  store: CanaryReleaseAssetStore,
  client: CanaryReleasePublisherClient,
  visibilityOptions: CanaryVisibilityOptions = {}
): Promise<CanaryReleasePublishResult> {
  const visibility = new CanaryVisibilityWindow(visibilityOptions);
  let publication = await verifyCanaryReleasePublication(expected, client);
  const uploaded: string[] = [];
  let createdDraft = false;
  const result = (): CanaryReleasePublishResult => ({
    outcome: createdDraft || uploaded.length > 0 ? 'published' : 'noop',
    releaseId: publication.releaseId,
    uploaded,
    createdDraft,
  });
  if (publication.state === 'complete') return result();

  // Check the whole prospective upload set before creating a draft or uploading
  // its first file, so a bad later file does not cause avoidable partial effects.
  for (const asset of publication.missing) await verifyLocalAsset(asset, store);
  publication = await verifyCanaryReleasePublication(expected, client);
  if (publication.state === 'complete') return result();
  const tag = `v${expected.version}`;
  const repoArgs = ['--repo', expected.repository];
  if (publication.state === 'absent') {
    await mutate(
      client,
      [
        'release',
        'create',
        tag,
        '--draft',
        '--target',
        expected.sourceSha,
        '--prerelease',
        '--latest=false',
        '--title',
        tag,
        '--notes',
        `Canary build from ${expected.sourceSha}.`,
        ...repoArgs,
      ],
      'draft creation'
    );
    createdDraft = true;
    publication = await visibility.read(
      () => verifyCanaryReleasePublication(expected, client),
      (observed) => observed.state !== 'absent'
    );
    if (publication.state === 'complete') return result();
    requireDraft(publication, 'after draft creation');
  }

  // Confirm each write before another mutation. All post-write audits share a
  // bounded wait; exhaustion fails instead of duplicating an upload.
  while (publication.missing.length > 0) {
    requireDraft(publication, 'before asset upload');
    const asset = publication.missing[0];
    if (!asset) throw new Error('Canary upload plan: expected a missing approved asset');
    if (uploaded.includes(asset.name)) {
      throw new Error(
        `Canary upload not confirmed for ${asset.name}: expected uploaded asset in fresh audit; external effects may exist, rerun with original approved bytes`
      );
    }
    const path = await verifyLocalAsset(asset, store);
    await mutate(
      client,
      ['release', 'upload', tag, path, ...repoArgs],
      `asset upload ${asset.name}`
    );
    uploaded.push(asset.name);
    publication = await visibility.read(
      () => verifyCanaryReleasePublication(expected, client),
      (observed) =>
        observed.state !== 'absent' &&
        !observed.missing.some((missing) => missing.name === asset.name)
    );
    if (publication.state === 'complete') return result();
  }

  requireDraft(publication, 'before publication');
  await mutate(
    client,
    ['release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false', ...repoArgs],
    'publication'
  );
  publication = await visibility.read(
    () => verifyCanaryReleasePublication(expected, client),
    (observed) => observed.state === 'complete'
  );
  if (publication.state !== 'complete') {
    throw new Error(
      `Canary publication not confirmed: expected immutable complete release; received ${publication.state}. External effects may exist, rerun with original approved bytes`
    );
  }
  return { ...result(), outcome: 'published' };
}

async function verifyLocalAsset(
  asset: CanaryReleaseExpectation['assets'][number],
  store: CanaryReleaseAssetStore
): Promise<string> {
  const path = store.path(asset.name);
  // gh treats '#' as an asset label separator. A literal label or leading
  // option must not change the uploaded filename after its digest was checked.
  if (!path || path.startsWith('-') || /[#\0\r\n]/.test(path) || basename(path) !== asset.name) {
    throw new Error(
      `Invalid upload path for ${asset.name}: expected a plain path with matching basename; received ${JSON.stringify(path)}`
    );
  }
  const bytes = await store.read(asset.name);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== asset.size || digest !== asset.sha256) {
    throw new Error(
      `Local canary asset mismatch ${asset.name}: expected size=${asset.size} sha256=${asset.sha256}; received size=${bytes.byteLength} sha256=${digest}`
    );
  }
  return path;
}

function requireDraft(publication: CanaryReleasePublication, phase: string): void {
  if (publication.state !== 'draft') {
    throw new Error(
      `Canary release ${phase}: expected audited draft; received ${publication.state}. External effects may exist, rerun with original approved bytes`
    );
  }
}

async function mutate(
  client: CanaryReleasePublisherClient,
  args: readonly string[],
  phase: string
): Promise<void> {
  try {
    const result = await client.writeCommand(args);
    if (result.exitCode !== 0) throw new Error(`GitHub command exit${result.exitCode}`);
  } catch (cause) {
    throw new Error(
      `Canary ${phase} failed; external effects may exist, rerun with original approved bytes`,
      { cause }
    );
  }
}
