import type { GenerateCommitMessageResponse, GitStatus } from '@mangostudio/shared/git';
import { parseCommitMessageOutput } from '@mangostudio/shared/git';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { resolveModel } from '../../generation/application/resolve-model';
import { GitCliError, runGit } from '../infrastructure/git-cli';
import { buildCommitContextWithMetadata } from './commit-context';

const COMMIT_MESSAGE_MAX_OUTPUT_TOKENS = 512;
const NO_HEAD_PATTERN =
  /does not have any commits yet|unknown revision or path not in the working tree/i;

export class EmptyGeneratedCommitMessageError extends Error {
  constructor() {
    super('The model returned an empty commit title.');
    this.name = 'EmptyGeneratedCommitMessageError';
  }
}

export class NoCommitChangesError extends Error {
  constructor() {
    super('The working tree has no changes to describe.');
    this.name = 'NoCommitChangesError';
  }
}

export interface GenerateCommitMessageInput {
  readonly userId: string;
  readonly chatId: string;
  readonly repoRoot: string;
  readonly status: GitStatus;
  readonly requestedModel?: string;
  readonly preferredModel: string;
  readonly chatModel?: string | null;
  readonly systemPrompt: string;
  readonly maxDiffBytes: number;
  readonly signal?: AbortSignal;
}

async function recentCommitSubjects(root: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const result = await runGit(['log', '--format=%s', '-10'], { cwd: root, signal });
    return result.stdout
      .split('\n')
      .map((subject) => subject.trim())
      .filter(Boolean);
  } catch (error) {
    if (
      error instanceof GitCliError &&
      error.exitCode === 128 &&
      NO_HEAD_PATTERN.test(error.stderr)
    ) {
      return [];
    }
    throw error;
  }
}

function selectedModel(input: GenerateCommitMessageInput): string | undefined {
  return (
    input.requestedModel?.trim() ||
    input.preferredModel.trim() ||
    input.chatModel?.trim() ||
    undefined
  );
}

function hasChanges(status: GitStatus): boolean {
  return (
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0 ||
    status.conflicted.length > 0
  );
}

export async function generateCommitMessageUseCase(
  input: GenerateCommitMessageInput
): Promise<GenerateCommitMessageResponse> {
  if (!hasChanges(input.status)) throw new NoCommitChangesError();

  const [stagedDiff, unstagedDiff, recentSubjects] = await Promise.all([
    runGit(['diff', '--cached', '--no-ext-diff', '--no-color'], {
      cwd: input.repoRoot,
      signal: input.signal,
    }),
    runGit(['diff', '--no-ext-diff', '--no-color'], {
      cwd: input.repoRoot,
      signal: input.signal,
    }),
    recentCommitSubjects(input.repoRoot, input.signal),
  ]);
  const commitContext = buildCommitContextWithMetadata({
    status: input.status,
    stagedDiff: stagedDiff.stdout,
    unstagedDiff: unstagedDiff.stdout,
    recentSubjects,
    maxDiffBytes: input.maxDiffBytes,
  });

  const { modelId, capabilities, providerType } = await resolveModel({
    requestedModel: selectedModel(input),
    userId: input.userId,
    type: 'text',
  });
  const provider = providerType
    ? getProvider(providerType)
    : await getProviderForModel(modelId, input.userId);
  await warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: 'text',
  });
  const result = await provider.generateText({
    userId: input.userId,
    chatId: input.chatId,
    history: [],
    prompt: commitContext.context,
    systemPrompt: input.systemPrompt,
    modelName: modelId,
    modelCapabilities: capabilities,
    signal: input.signal,
    generationConfig: {
      thinkingEnabled: false,
      reasoningEffort: 'low',
      maxOutputTokens: COMMIT_MESSAGE_MAX_OUTPUT_TOKENS,
    },
  });

  const parsed = parseCommitMessageOutput(result.text);
  if (!parsed.title) throw new EmptyGeneratedCommitMessageError();
  return { ...parsed, truncated: commitContext.truncated };
}
