import { createHash } from 'node:crypto';

import type { CanaryApprovalAcquisition } from './canary-approval';
import { parseCanaryPushContext } from './canary-promotion';
import {
  type CanaryPromotionReceipt,
  createCanaryApprovalPayload,
  createCanaryPublicationEvidence,
  parseCanaryPromotionReceipt,
  sameApprovedArtifact,
} from './canary-publication-evidence';
import type { CanarySource } from './canary-source';
import { writeCanarySourceSnapshot } from './canary-source-snapshot';
import type { CanaryValidationReceipt } from './canary-validation';

/** Authenticated acquisition and qualification boundaries; qualification must read the exact selected CI attempt. */
export interface CanaryApprovalPreparationServices {
  acquire(
    source: CanarySource,
    version: string,
    executionRevision: string
  ): Promise<CanaryApprovalAcquisition>;
  qualify(source: CanarySource, verifiedPushBeforeSha?: string): Promise<CanaryValidationReceipt>;
}

/** Frozen source identity and current approval job identity. */
export interface CanaryApprovalPreparationInput {
  readonly source: CanarySource;
  readonly version: string;
  readonly executionRevision: string;
  readonly producerAttempt: number;
  readonly expectedApprovalSha256?: string;
}

/** Parse source job outputs or its structured snapshot; reject mixed workflow/source identities. Example: parseCanaryApprovalSelection(process.env.SELECTION_JSON!, repo, version, revision). */
export function parseCanaryApprovalSelection(
  raw: string,
  repository: string,
  version: string,
  executionRevision: string
): CanarySource {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Invalid SELECTION_JSON: expected JSON object', { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'Invalid SELECTION_JSON: expected source snapshot or source job outputs object'
    );
  const entry = value as Record<string, unknown>;
  const source = entry.source ?? {
    repository: entry.repository,
    sourceSha: entry.source_sha ?? entry.sha,
    runId: Number(entry.run_id),
    runAttempt: Number(entry.run_attempt),
    runNumber: Number(entry.run_number),
    runUrl: entry.run_url,
    workflowId: Number(entry.workflow_id),
    workflowPath: entry.workflow_path,
  };
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new Error(
      `Invalid selected source: expected complete CI selection object; received ${JSON.stringify(source)}`
    );
  if (entry.version !== undefined && entry.version !== version)
    throw new Error(
      `Invalid source version: expected ${version}; received ${JSON.stringify(entry.version)}`
    );
  if (entry.channel !== undefined && entry.channel !== 'canary')
    throw new Error(
      `Invalid source channel: expected canary; received ${JSON.stringify(entry.channel)}`
    );
  if (entry.executionRevision !== undefined && entry.executionRevision !== executionRevision)
    throw new Error('Invalid source executionRevision: expected current trusted execution SHA');
  const parsed = writeCanarySourceSnapshot(
    { source: source as CanarySource, executionRevision, restored: false },
    { sourceSha: (source as CanarySource).sourceSha, version, channel: 'canary', executionRevision }
  ).snapshot.source;
  if (parsed.repository !== repository)
    throw new Error(
      `Invalid source repository: expected ${repository}; received ${parsed.repository}`
    );
  return parsed;
}

/** Qualify both current selection and original distribution, then freeze or copy approval bytes. Acquisition authenticates archives before this function uses them. Example: await prepareCanaryApproval(input, services). */
export async function prepareCanaryApproval(
  input: CanaryApprovalPreparationInput,
  services: CanaryApprovalPreparationServices
) {
  const source = parseCanaryApprovalSelection(
    JSON.stringify({ source: input.source, executionRevision: input.executionRevision }),
    input.source.repository,
    input.version,
    input.executionRevision
  );
  if (!Number.isSafeInteger(input.producerAttempt) || input.producerAttempt < 1)
    throw new Error(
      `Invalid producerAttempt: expected positive safe integer; received ${input.producerAttempt}`
    );
  const pin = input.expectedApprovalSha256;
  if (pin !== undefined && !/^[a-f0-9]{64}$/.test(pin))
    throw new Error(`Invalid EXPECTED_APPROVAL_SHA256: expected full SHA256; received ${pin}`);
  const acquisition = await services.acquire(source, input.version, input.executionRevision);
  const recovered = acquisition.receipt !== undefined;
  if (
    recovered !== (acquisition.approvalPayload !== undefined) ||
    (acquisition.origin !== 'ci' && !recovered) ||
    (recovered && typeof acquisition.promotionRaw !== 'string')
  )
    throw new Error(
      'Invalid acquired approval: expected recovered receipt and exact archive together'
    );
  if (
    pin !== undefined &&
    (!recovered || !acquisition.approvalPayload || hash(acquisition.approvalPayload) !== pin)
  )
    throw new Error(
      `Approved payload unavailable: expected existing approval SHA256 ${pin}; refusing new approval`
    );
  let before: string | undefined;
  if (acquisition.pushContextRaw !== undefined)
    before = parseCanaryPushContext(
      acquisition.pushContextRaw,
      source.repository,
      source.sourceSha
    ).before;
  const qualify = async (selected: CanarySource) => {
    const verifiedBefore =
      selected.runId === acquisition.distribution.checksums.runId ? before : undefined;
    const result = await services.qualify(selected, verifiedBefore);
    if (
      result.source.repository !== selected.repository ||
      result.source.sourceSha !== selected.sourceSha ||
      result.source.runId !== selected.runId ||
      result.source.runAttempt !== selected.runAttempt ||
      result.source.pushBeforeSha !== verifiedBefore
    )
      throw new Error(
        'Qualification identity mismatch: expected requested exact CI run/attempt and authenticated push range'
      );
    return result;
  };
  const currentQualification = await qualify(source);
  const receiptSource = acquisition.receipt?.selectedRun ?? source;
  const originalQualification = sameSource(source, receiptSource)
    ? currentQualification
    : await qualify(receiptSource);
  if (originalQualification.builderAttempt !== acquisition.distribution.checksums.producerAttempt)
    throw new Error(
      `Qualification builder mismatch: expected frozen producer attempt ${acquisition.distribution.checksums.producerAttempt}; received ${originalQualification.builderAttempt}`
    );
  const receipt: CanaryPromotionReceipt = acquisition.receipt ?? {
    schemaVersion: 1,
    selectedRun: source,
    workflowRevision: input.executionRevision,
    manifestSha256: hash(Buffer.from(acquisition.manifestRaw)),
    distribution: acquisition.distribution,
    qualification: originalQualification,
  };
  parseCanaryPromotionReceipt(JSON.stringify(receipt), source.repository, source.sourceSha);
  if (
    receipt.distribution.builtAt !== acquisition.distribution.builtAt ||
    (['checksums', 'assets', 'npm'] as const).some(
      (scope) =>
        !sameApprovedArtifact(receipt.distribution[scope], acquisition.distribution[scope]) ||
        receipt.distribution[scope].runAttempt !== acquisition.distribution[scope].runAttempt
    )
  )
    throw new Error(
      'Acquired distribution mismatch: expected original receipt immutable artifact pointers'
    );
  const payload =
    acquisition.approvalPayload ??
    (await createCanaryApprovalPayload(
      acquisition.manifestRaw,
      receipt,
      acquisition.checksumsBundle,
      acquisition.pushContextRaw
    ));
  const evidence = createCanaryPublicationEvidence(
    acquisition.manifestRaw,
    receipt,
    acquisition.checksumsBundle,
    payload
  );
  if (evidence.expected.version !== input.version)
    throw new Error(
      `Approval version mismatch: expected ${input.version}; received ${evidence.expected.version}`
    );
  const promotionRaw = acquisition.promotionRaw ?? `${JSON.stringify(receipt, null, 2)}\n`;
  if (promotionRaw !== Buffer.from(evidence.generated.get('promotion.json') ?? []).toString())
    throw new Error(
      'Recovered promotion encoding differs from frozen publication metadata; refusing to rewrite original receipt'
    );
  const expectedRaw = `${JSON.stringify(evidence.expected, null, 2)}\n`;
  const payloadSha256 = hash(payload);
  return {
    acquisition,
    receipt,
    promotionRaw,
    approvalPayload: payload,
    payloadSha256,
    artifactName: `canary-approval-${source.sourceSha}-${input.version}-${payloadSha256}-${input.producerAttempt}`,
    expectedRaw,
    expectedSha256: hash(Buffer.from(expectedRaw)),
    generated: evidence.generated,
    currentQualification,
    originalQualification,
  };
}

function sameSource(left: CanarySource, right: CanarySource): boolean {
  return (
    [
      'repository',
      'sourceSha',
      'runId',
      'runAttempt',
      'runNumber',
      'runUrl',
      'workflowId',
      'workflowPath',
    ] as const
  ).every((key) => left[key] === right[key]);
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
