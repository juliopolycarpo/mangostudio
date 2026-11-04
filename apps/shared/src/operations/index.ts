import Type, { type Static } from 'typebox';

export const OperationIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
});
export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OperationStateSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('unresolved'),
]);
export type OperationState = Static<typeof OperationStateSchema>;
export const OperationReceiptSchema = Type.Object({
  operationId: OperationIdSchema,
  kind: Type.Union([Type.Literal('create-chat'), Type.Literal('submit-turn')]),
  state: OperationStateSchema,
  chatId: Type.Union([Type.String(), Type.Null()]),
  messageId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
});
export type OperationReceipt = Static<typeof OperationReceiptSchema>;
