import { extname, isAbsolute, join } from 'node:path';

import type { LibraryLocationId } from '@mangostudio/shared/library';
import {
  defineCustomInstructionLocation,
  getLibraryLocation,
} from '@mangostudio/shared/library/host';
import type {
  FixedRuleFileKind,
  RuleFileDescriptor,
  RuleFilePreviewResponse,
} from '@mangostudio/shared/prompt-rules';
import type { PathEnv } from '@mangostudio/shared/runtime-env';

import {
  readRegularFileUtf8,
  type RegularFileContent,
  RegularFileReadError,
  statRegularFile,
} from '../../../lib/safe-file';
import { createLibraryPathEnv } from '../../library/infrastructure/location-probe';

const MAX_CONTENT_BYTES = 256 * 1024;

const ALLOWED_EXT = '.md';

/**
 * The two rule files MangoStudio offers out of the box, each as the library
 * registry location it reads. This holds ids only: the path of each file is the
 * registry's, so `CLAUDE_CONFIG_DIR` and `MANGOSTUDIO_CONFIG_HOME` move it here
 * exactly as they move it in the library matrix.
 */
export const FIXED_RULE_FILE_LOCATIONS: Readonly<
  Record<FixedRuleFileKind, { readonly label: string; readonly locationId: LibraryLocationId }>
> = {
  agents: { label: 'Mango AGENTS.md', locationId: 'mango-instructions' },
  claude: { label: 'Claude CLAUDE.md', locationId: 'claude-instructions' },
};

export class RuleFileError extends Error {
  constructor(
    message: string,
    // Literals, not `number`: the route answers `status(error.status, ...)`, and a
    // literal union types each status into Eden's error channel.
    readonly status: 404 | 422,
    readonly code: string
  ) {
    super(message);
    this.name = 'RuleFileError';
  }
}

/**
 * Absolute path of a fixed rule file as the library registry resolves it, or
 * null where the registry has no path for it (an unsupported platform).
 */
export function resolveFixedRuleFilePath(
  kind: FixedRuleFileKind,
  env: PathEnv = createLibraryPathEnv()
): string | null {
  const { locationId } = FIXED_RULE_FILE_LOCATIONS[kind];
  const location = getLibraryLocation(locationId);
  if (!location) {
    throw new TypeError(
      `Fixed rule file "${kind}" names unknown library location "${locationId}".`
    );
  }
  return location.resolvePath(env);
}

function expandTilde(raw: string, env: PathEnv): string {
  if (raw.startsWith('~')) {
    return join(env.homeDir, raw.slice(1));
  }
  return raw;
}

/**
 * The safety gate for a user-named path: absolute or `~`-prefixed, nothing
 * relative. The `.md` extension check is separate and applies to fixed files too.
 */
function validateCustomPath(raw: string, env: PathEnv): string {
  if (raw.startsWith('~')) {
    return expandTilde(raw, env);
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
  kind: FixedRuleFileKind,
  label: string,
  locationId: LibraryLocationId,
  filePath: string
): RuleFileDescriptor {
  try {
    const { sizeBytes } = statRegularFile(filePath);
    return { kind, locationId, label, path: filePath, exists: true, readable: true, sizeBytes };
  } catch (error) {
    return buildUnreadableDescriptor(kind, label, locationId, filePath, error);
  }
}

function buildUnreadableDescriptor(
  kind: FixedRuleFileKind,
  label: string,
  locationId: LibraryLocationId,
  filePath: string,
  error: unknown
): RuleFileDescriptor {
  if (error instanceof RegularFileReadError && error.reason !== 'not-found') {
    const message =
      error.reason === 'not-regular-file' ? 'Path is not a regular file' : 'File is not readable';
    return {
      kind,
      locationId,
      label,
      path: filePath,
      exists: true,
      readable: false,
      error: message,
    };
  }

  return { kind, locationId, label, path: filePath, exists: false, readable: false };
}

export function getDefaultRuleFileDescriptors(
  env: PathEnv = createLibraryPathEnv()
): RuleFileDescriptor[] {
  return (Object.keys(FIXED_RULE_FILE_LOCATIONS) as FixedRuleFileKind[]).map((kind) => {
    const { label, locationId } = FIXED_RULE_FILE_LOCATIONS[kind];
    const path = resolveFixedRuleFilePath(kind, env);
    if (path === null) {
      // The registry has no path for this platform; there is no file to describe.
      return {
        kind,
        locationId,
        label,
        path: '',
        exists: false,
        readable: false,
        error: 'Not available on this platform',
      };
    }
    return buildDescriptor(kind, label, locationId, path);
  });
}

/** Content of a fixed rule file at its registry path, or null when it cannot be read. */
export function loadFixedRuleFileContent(
  kind: FixedRuleFileKind,
  env: PathEnv = createLibraryPathEnv()
): string | null {
  try {
    const path = resolveFixedRuleFilePath(kind, env);
    if (path === null) return null;
    assertMarkdownExtension(path);
    return readRuleFile(path).content;
  } catch {
    return null;
  }
}

/**
 * Resolve a user-named path through the registry's read-only `custom-instruction`
 * kind. Validation runs first, so the registry only ever sees a checked path.
 */
function resolveCustomRuleFile(
  rawPath: string,
  env: PathEnv
): { locationId: LibraryLocationId; path: string } {
  const validated = validateCustomPath(rawPath, env);
  assertMarkdownExtension(validated);
  const location = defineCustomInstructionLocation(validated);
  const path = location.resolvePath(env);
  if (path === null) {
    throw new RuleFileError('Custom rule file path cannot be resolved', 422, 'VALIDATION');
  }
  return { locationId: location.id, path };
}

export function loadRuleFileContent(
  rawPath: string,
  env: PathEnv = createLibraryPathEnv()
): string | null {
  try {
    return readRuleFile(resolveCustomRuleFile(rawPath, env).path).content;
  } catch {
    return null;
  }
}

export function previewRuleFile(
  rawPath: string,
  env: PathEnv = createLibraryPathEnv()
): RuleFilePreviewResponse {
  const { locationId, path } = resolveCustomRuleFile(rawPath, env);

  let file: RegularFileContent;
  try {
    file = readRuleFile(path);
  } catch (error) {
    throw toRuleFileError(error);
  }

  return {
    locationId,
    label: rawPath,
    path: rawPath,
    exists: true,
    readable: true,
    sizeBytes: file.sizeBytes,
    content: file.content,
    truncated: file.truncated,
  };
}
