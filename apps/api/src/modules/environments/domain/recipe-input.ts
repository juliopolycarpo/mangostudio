import type { NodeVersionSpec, RecipeInput } from '@mangostudio/shared/environments';

const NODE_VERSION_SPEC_PATTERN = /^(?:lts|latest|\d+(?:\.\d+){0,2})$/;
const NODE_VERSION_SPEC_MAX_LENGTH = 32;

export class RecipeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeInputError';
  }
}

export function parseNodeVersionSpec(value: string): NodeVersionSpec | null {
  if (value.length > NODE_VERSION_SPEC_MAX_LENGTH || !NODE_VERSION_SPEC_PATTERN.test(value)) {
    return null;
  }
  return value as NodeVersionSpec;
}

export function assertNodeVersionSpec(value: string): NodeVersionSpec {
  const parsed = parseNodeVersionSpec(value);
  if (!parsed) {
    throw new RecipeInputError('Node version must be lts, latest, or one to three numeric parts.');
  }
  return parsed;
}

export function assertRecipeInput(
  input: RecipeInput,
  expectedKind: RecipeInput['kind']
): RecipeInput {
  if (input.kind !== expectedKind) {
    throw new RecipeInputError(`Recipe requires ${expectedKind} input.`);
  }
  if (input.kind === 'node-version') {
    assertNodeVersionSpec(input.version);
  }
  return input;
}

export function toNvmVersionArgument(version: NodeVersionSpec): string {
  const validated = assertNodeVersionSpec(version);
  if (validated === 'lts') return '--lts';
  if (validated === 'latest') return 'node';
  return validated;
}

export function toNvmDefaultArgument(version: NodeVersionSpec): string {
  const validated = assertNodeVersionSpec(version);
  if (validated === 'lts') return 'lts/*';
  if (validated === 'latest') return 'node';
  return validated;
}
