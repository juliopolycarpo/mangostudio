import type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewResponse,
} from '@mangostudio/shared/prompt-rules';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'fs';
import { homedir } from 'os';
import { extname, isAbsolute, join } from 'path';

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

function isReadableRegularFile(absolutePath: string): boolean {
  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) return false;
    readFileSync(absolutePath, { flag: 'r' });
    return true;
  } catch {
    return false;
  }
}

function getFileSize(absolutePath: string): number | undefined {
  try {
    return lstatSync(absolutePath).size;
  } catch {
    return undefined;
  }
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

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && 'errno' in err;
}

function assertRegularFile(filePath: string): void {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile()) {
      throw new RuleFileError('Path is not a regular file', 422, 'VALIDATION');
    }
  } catch (err: unknown) {
    if (err instanceof RuleFileError) throw err;

    if (isErrnoException(err) && err.code === 'ENOENT') {
      throw new RuleFileError('File not found', 404, 'NOT_FOUND');
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new RuleFileError(`Cannot access file: ${message}`, 422, 'VALIDATION');
  }
}

function readFileContent(absolutePath: string): { content: string; truncated: boolean } {
  const stat = lstatSync(absolutePath);
  const shouldTruncate = stat.size > MAX_CONTENT_BYTES;

  try {
    if (shouldTruncate) {
      const buffer = Buffer.alloc(MAX_CONTENT_BYTES);
      const fd = openSync(absolutePath, 'r');
      try {
        readSync(fd, buffer, 0, MAX_CONTENT_BYTES, 0);
      } finally {
        closeSync(fd);
      }
      return { content: buffer.toString('utf8'), truncated: true };
    }

    return { content: readFileSync(absolutePath, 'utf8'), truncated: false };
  } catch {
    throw new RuleFileError('File is not readable', 422, 'VALIDATION');
  }
}

function buildDescriptor(
  kind: FixedRuleFileKind | undefined,
  label: string,
  filePath: string
): RuleFileDescriptor {
  const resolved = expandTilde(filePath);
  const ex = existsSync(resolved);

  if (!ex) {
    return {
      kind,
      label,
      path: filePath,
      exists: false,
      readable: false,
    };
  }

  try {
    const stat = lstatSync(resolved);
    if (!stat.isFile()) {
      return {
        kind,
        label,
        path: filePath,
        exists: true,
        readable: false,
        error: 'Path is not a regular file',
      };
    }
  } catch {
    return {
      kind,
      label,
      path: filePath,
      exists: true,
      readable: false,
      error: 'Cannot stat file',
    };
  }

  const readable = isReadableRegularFile(resolved);

  return {
    kind,
    label,
    path: filePath,
    exists: true,
    readable,
    sizeBytes: readable ? getFileSize(resolved) : undefined,
    error: readable ? undefined : 'File is not readable',
  };
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

    if (!existsSync(resolved)) return null;

    assertRegularFile(resolved);

    if (!isReadableRegularFile(resolved)) return null;

    return readFileContent(resolved).content;
  } catch {
    return null;
  }
}

export function previewRuleFile(rawPath: string): RuleFilePreviewResponse {
  const resolved = validateCustomPath(rawPath);
  assertMarkdownExtension(resolved);
  assertRegularFile(resolved);

  if (!isReadableRegularFile(resolved)) {
    throw new RuleFileError('File is not readable', 422, 'VALIDATION');
  }

  const { content, truncated } = readFileContent(resolved);
  const sizeBytes = getFileSize(resolved);

  return {
    label: rawPath,
    path: rawPath,
    exists: true,
    readable: true,
    sizeBytes,
    content,
    truncated,
  };
}
