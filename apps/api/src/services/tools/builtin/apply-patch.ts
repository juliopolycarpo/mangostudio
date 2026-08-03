/**
 * Built-in tool: apply_patch
 * Resolves hub-owned path policy before delegating patch execution to the runtime.
 */

import type { RuntimePatchOperation } from '@mangostudio/runtime';
import { getRuntimeClient } from '../../runtime-client';
import { getRequiredTextArg, ToolArgumentError } from '../arg-parsing';
import { persistRuntimeMutations } from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  normalizePathValidationSettings,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  type ResolvePathOptions,
  resolveAndValidatePath,
  runtimePathPolicy,
} from './_fs-utils';
import { parseV4aPatch, type V4aPatchOperation } from './_v4a-patch';

const APPLY_PATCH_TOOL_NAME = 'apply_patch';

export interface ApplyPatchToolArgs {
  patch: string;
}

interface ApplyPatchFileResult {
  readonly path: string;
  readonly op: 'add' | 'update' | 'delete' | 'move';
  readonly movedTo?: string;
  readonly sha256?: string;
}

export interface ApplyPatchToolResult {
  readonly files: readonly ApplyPatchFileResult[];
  readonly summary: string;
}

export type ApplyPatchToolSettings = PathValidationSettings;

const definition = {
  name: APPLY_PATCH_TOOL_NAME,
  description:
    'Plans and validates one context-anchored patch across text files before writing any ' +
    'changes. Existing files must be read completely with read_file first. Format:\n' +
    '*** Begin Patch\n' +
    '*** Add File: path\n+new content\n' +
    '*** Update File: path\n*** Move to: new-path\n@@ optional context marker\n' +
    ' unchanged context\n-old text\n+new text\n' +
    '*** Delete File: path\n*** End Patch\n' +
    'Add-file lines require "+". Update lines require a leading space, "+", or "-". ' +
    'Move is optional and must immediately follow its Update header. Include enough unchanged ' +
    'context to identify each hunk uniquely; line numbers are not used.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The complete V4A patch, including Begin Patch and End Patch lines.',
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
};

export function normalizeApplyPatchToolSettings(
  parameters: Record<string, unknown>
): ApplyPatchToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeApplyPatch(
  args: ApplyPatchToolArgs,
  context: ToolContext
): Promise<ApplyPatchToolResult> {
  const parsed = parseV4aPatch(args.patch);
  const settings = normalizeApplyPatchToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const validationOptions = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const operations = resolveOperations(parsed.operations, validationOptions);
  const { result, mutations } = await runtime.fs.applyPatch(
    {
      chatId: context.chatId,
      operations,
      captureSnapshot: Boolean(context.assistantMessageId),
      ...runtimePathPolicy(validationOptions),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  await persistRuntimeMutations(context, mutations);
  return result;
}

function resolveOperations(
  operations: readonly V4aPatchOperation[],
  validationOptions: ResolvePathOptions
): RuntimePatchOperation[] {
  const resolved: RuntimePatchOperation[] = [];
  const failures: Array<{ description: string; error: unknown }> = [];
  for (const operation of operations) {
    try {
      resolved.push(resolveOperation(operation, validationOptions));
    } catch (error) {
      failures.push({ description: describeOperation(operation), error });
    }
  }
  if (failures.length > 0) throwOperationFailures(failures);
  return resolved;
}

function resolveOperation(
  operation: V4aPatchOperation,
  validationOptions: ResolvePathOptions
): RuntimePatchOperation {
  const resolvedPath = resolveAndValidatePath(operation.path, validationOptions);
  if (operation.type === 'add') {
    return {
      type: 'add',
      inputPath: operation.path,
      resolvedPath,
      content: operation.content,
    };
  }
  if (operation.type === 'delete') {
    return {
      type: 'delete',
      inputPath: operation.path,
      resolvedPath,
    };
  }
  return {
    type: 'update',
    inputPath: operation.path,
    resolvedPath,
    ...(operation.moveTo
      ? {
          moveTo: operation.moveTo,
          resolvedMoveTo: resolveAndValidatePath(operation.moveTo, validationOptions),
        }
      : {}),
    hunks: operation.hunks,
  };
}

function describeOperation(operation: V4aPatchOperation): string {
  const label =
    operation.type === 'add' ? 'Add' : operation.type === 'delete' ? 'Delete' : 'Update';
  return `${label} "${operation.path}"`;
}

function throwOperationFailures(
  failures: readonly { description: string; error: unknown }[]
): never {
  const [failure] = failures;
  if (failures.length === 1 && failure?.error instanceof Error) {
    failure.error.message = `Patch could not be applied:\n- ${failure.description}: ${failure.error.message}`;
    throw failure.error;
  }
  throw new ToolArgumentError(
    `Patch could not be applied:\n${failures
      .map(({ description, error }) => {
        const message = error instanceof Error ? error.message : String(error);
        return `- ${description}: ${message}`;
      })
      .join('\n')}`
  );
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ApplyPatchToolResult> {
  const patch = getRequiredTextArg(args.patch, 'patch');
  return executeApplyPatch({ patch }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Apply patch',
      description:
        'Allows the AI to apply context-anchored changes across multiple text files at once.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsWrite'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool may apply patches. Leave empty to allow all.',
        'List of paths where the tool may not apply patches. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
