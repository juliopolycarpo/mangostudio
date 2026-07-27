import { type Static, Type } from '@sinclair/typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

/**
 * Target-neutral representation of a file-backed subagent. Vendor framing is
 * deliberately excluded: adapters parse into this shape, then render the
 * destination dialect and report anything that could not cross that boundary.
 */
export const SubagentDescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  tools: Type.Optional(ReadonlyArraySchema(Type.String({ minLength: 1 }))),
  model: Type.Optional(Type.String({ minLength: 1 })),
  body: Type.String(),
});

export type SubagentDescriptor = Static<typeof SubagentDescriptorSchema>;
