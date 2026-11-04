import { createHash } from 'node:crypto';

import {
  assertCanaryManifestIdentity,
  type CanaryPromotionReceipt,
  createCanaryPublicationEvidence,
} from './canary-publication-evidence';

/** Downloaded original assets and output boundary; stage must use the supplied fixed builder completion time. */
export interface CanaryApprovalStageStore {
  stage(version: string, sourceSha: string, builtAt: string): Promise<void>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array>;
}

/** Stage approved assets and verify the final immutable map before a publisher can mutate GitHub. The caller authenticates the approval archive; both hashes pin its prepare-job outputs. Example: await stageApprovedCanary(input, store). */
export async function stageApprovedCanary(
  input: {
    readonly manifestRaw: string;
    readonly receipt: CanaryPromotionReceipt;
    readonly checksumsBundle: Uint8Array;
    readonly approvalPayload: Uint8Array;
    readonly approvalPayloadSha256: string;
    readonly expectedReleaseSha256: string;
  },
  store: CanaryApprovalStageStore
): Promise<readonly string[]> {
  assertCanaryManifestIdentity(input.manifestRaw, input.receipt);
  if (
    !/^[a-f0-9]{64}$/.test(input.approvalPayloadSha256) ||
    hash(input.approvalPayload) !== input.approvalPayloadSha256
  )
    throw new Error(`Invalid approved archive: expected SHA256 ${input.approvalPayloadSha256}`);
  const evidence = createCanaryPublicationEvidence(
    input.manifestRaw,
    input.receipt,
    input.checksumsBundle,
    input.approvalPayload
  );
  const expectedRaw = `${JSON.stringify(evidence.expected, null, 2)}\n`;
  if (
    !/^[a-f0-9]{64}$/.test(input.expectedReleaseSha256) ||
    hash(Buffer.from(expectedRaw)) !== input.expectedReleaseSha256
  )
    throw new Error(
      `Invalid expected release map: expected prepare-job SHA256 ${input.expectedReleaseSha256}`
    );
  await store.stage(
    evidence.expected.version,
    evidence.expected.sourceSha,
    input.receipt.distribution.builtAt
  );
  for (const [name, bytes] of evidence.generated) await store.write(name, bytes);
  for (const asset of evidence.expected.assets) {
    const bytes = await store.read(asset.name);
    if (bytes.byteLength !== asset.size || hash(bytes) !== asset.sha256)
      throw new Error(
        `Invalid staged asset ${asset.name}: expected ${asset.size} bytes and SHA256 ${asset.sha256}`
      );
  }
  return evidence.expected.assets.map((asset) => asset.name);
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
