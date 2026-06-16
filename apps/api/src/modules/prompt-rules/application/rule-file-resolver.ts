import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewResponse,
} from '@mangostudio/shared/prompt-rules';
import {
  type RegularFileContent,
  RegularFileReadError,
  readRegularFileUtf8,
  statRegularFile,
} from '../../../lib/safe-file';

const MAX_CONTENT_BYTES = 256 * 1024;

const ALLOWED_EXT = '.md';

const FIXED_PATHS: ReadonlyMap<FixedRuleFileKind, { label: string; path: string }> = new Map([
  ['agents', { label: 'Mango AGENTS.md', path: join(homedir(), '.mango', 'AGENTS.md') }],
  ['claude', { label: 'Claude CLAUDE.md', path: join(homedir(), '.claude', 'CLAUDE.md') }],
]);

export class RuleFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'RuleFileError';
  }
}

function expandTilde(raw: string): string {
  if (raw.startsWith('~')) {
    return join(homedir(), raw.slice(1));
  }
  return raw;
}

function validateCustomPath(raw: string): string {
  if (raw.startsWith('~')) {
    return expandTilde(raw);
  }

  if (!isAbsolute(raw)) {
    throw new RuleFileError(
      'Custom rule file paths must be absolute or start with ~',
      422,
      'VALIDATION'
    );
  }

  return raw;
}

function assertMarkdownExtension(filePath: string): void {
  if (extname(filePath) !== ALLOWED_EXT) {
    throw new RuleFileError('Only .md files are allowed', 422, 'VALIDATION');
  }
}

/** Open the rule file once and read it, truncating content above the cap. */
function readRuleFile(absolutePath: string): RegularFileContent {
  return readRegularFileUtf8(absolutePath, { maxBytes: MAX_CONTENT_BYTES, truncateOversize: true });
}

function toRuleFileError(error: unknown): RuleFileError {
  if (error instanceof RuleFileError) return error;
  if (error instanceof RegularFileReadError) {
    if (error.reason === 'not-found') return new RuleFileError('File not found', 404, 'NOT_FOUND');
    if (error.reason === 'not-regular-file') {
      return new RuleFileError('Path is not a regular file', 422, 'VALIDATION');
    }
    return new RuleFileError('File is not readable', 422, 'VALIDATION');
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  return new RuleFileError(`Cannot access file: ${message}`, 422, 'VALIDATION');
}

function buildDescriptor(
  kind: FixedRuleFileKind | undefined,
  label: string,
  filePath: string
): RuleFileDescriptor {
  const resolved = expandTilde(filePath);

  try {
    const { sizeBytes } = statRegularFile(resolved);
    return { kind, label, path: filePath, exists: true, readable: true, sizeBytes };
  } catch (error) {
    return buildUnreadableDescriptor(kind, label, filePath, error);
  }
}

function buildUnreadableDescriptor(
  kind: FixedRuleFileKind | undefined,
  label: string,
  filePath: string,
  error: unknown
): RuleFileDescriptor {
  if (error instanceof RegularFileReadError && error.reason !== 'not-found') {
    const message =
      error.reason === 'not-regular-file' ? 'Path is not a regular file' : 'File is not readable';
    return { kind, label, path: filePath, exists: true, readable: false, error: message };
  }

  return { kind, label, path: filePath, exists: false, readable: false };
}

export function getDefaultRuleFileDescriptors(): RuleFileDescriptor[] {
  return [...FIXED_PATHS.entries()].map(([kind, { label, path }]) =>
    buildDescriptor(kind, label, path)
  );
}

export function loadRuleFileContent(rawPath: string): string | null {
  try {
    const resolved = validateCustomPath(rawPath);
    assertMarkdownExtension(resolved);
    return readRuleFile(resolved).content;
  } catch {
    return null;
  }
}

export function previewRuleFile(rawPath: string): RuleFilePreviewResponse {
  const resolved = validateCustomPath(rawPath);
  assertMarkdownExtension(resolved);

  let file: RegularFileContent;
  try {
    file = readRuleFile(resolved);
  } catch (error) {
    throw toRuleFileError(error);
  }

  return {
    label: rawPath,
    path: rawPath,
    exists: true,
    readable: true,
    sizeBytes: file.sizeBytes,
    content: file.content,
    truncated: file.truncated,
  };
}
