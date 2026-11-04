import type { RespondStreamBody } from '@mangostudio/shared/generation';
import { type OperationReceipt, OperationReceiptSchema } from '@mangostudio/shared/operations';
import Value from 'typebox/value';

import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

export async function getOperation(operationId: string): Promise<OperationReceipt | null> {
  const { data, error, status } = await client.api.operations({ operationId }).get();
  if (status === 404) return null;
  if (error) throw new ApiError(error.value);
  if (!Value.Check(OperationReceiptSchema, data)) throw new Error('Invalid operation receipt');
  return data;
}
export async function submitOperation(
  body: RespondStreamBody & { operationId: string }
): Promise<OperationReceipt> {
  const { data, error } = await client.api.respond.stream.post(body);
  if (error) throw new ApiError(error.value);
  if (!Value.Check(OperationReceiptSchema, data)) throw new Error('Invalid operation receipt');
  return data;
}
