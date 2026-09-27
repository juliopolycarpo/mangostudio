/**
 * Named stand-ins for the library write RPCs, for Hub tests whose case must be
 * refused before any machine is written. A call that reaches one of these is
 * the failure: it throws naming the method and the destinations it was sent,
 * so a validation that stopped holding reads as exactly that rather than as a
 * write landing somewhere unintended.
 */

import type { PropagationApply, RemovalApply } from '@mangostudio/shared/library';
import type {
  RuntimeLibraryApplyParams,
  RuntimeLibraryRemoveParams,
} from '@mangostudio/shared/runtime-contract';

function destinations(params: {
  readonly environmentId?: string;
  readonly operations: readonly { readonly locationId: string }[];
}): string {
  return params.operations
    .map((operation) => `${params.environmentId ?? '<unnamed>'}/${operation.locationId}`)
    .join(', ');
}

/**
 * `runtimeApply` that must never be called.
 *
 * @example
 * await expect(
 *   applyLibraryPropagation(userId, request, { runtimeApply: refuseLibraryApply })
 * ).rejects.toMatchObject({ status: 422 });
 */
export function refuseLibraryApply(params: RuntimeLibraryApplyParams): Promise<PropagationApply> {
  return Promise.reject(
    new Error(
      `expected no write to reach the runtime | received library.apply for ${destinations(params)}`
    )
  );
}

/**
 * `runtimeRemove` that must never be called.
 *
 * @example
 * await expect(
 *   applyLibraryRemoval(userId, request, { runtimeRemove: refuseLibraryRemove })
 * ).rejects.toBeInstanceOf(LibraryRequestError);
 */
export function refuseLibraryRemove(params: RuntimeLibraryRemoveParams): Promise<RemovalApply> {
  return Promise.reject(
    new Error(
      `expected no write to reach the runtime | received library.remove for ${destinations(params)}`
    )
  );
}
