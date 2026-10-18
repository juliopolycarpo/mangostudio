import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ignoredSegments = [
  '/node_modules/',
  '/dist/',
  '/coverage/',
  '/.mango/out/',
  '/playwright-report/',
  '/test-results/',
];
const biomeExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
  '.css',
  '.html',
]);
const dprintExtensions = new Set(['.md', '.mdx', '.toml', '.yml', '.yaml']);

/**
 * Read the touched file path from Claude or Codex hook JSON.
 * // Usage: const filePath = extractTouchedFilePath(input);
 */
export function extractTouchedFilePath(input) {
  const parsed = parseHookInput(input);
  return (
    parsed?.tool_input?.file_path ??
    parsed?.tool_input?.path ??
    parsed?.file_path ??
    parsed?.path ??
    ''
  );
}

/**
 * Read the hook's absolute working directory, falling back to the repository root.
 * // Usage: const cwd = extractHookCwd(input); // '/repo/packages/protocol'
 */
export function extractHookCwd(input, root = repoRoot) {
  const cwd = parseHookInput(input)?.cwd;
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : root;
}

/**
 * List the absolute paths a touched file may name: from the hook cwd first, then the repo root
 * when the cwd is inside the repo, since agents also send repo-relative paths from nested dirs.
 * // Usage: candidatePaths('CHANGELOG.md', '/repo/packages/protocol', '/repo'); // ['/repo/packages/protocol/CHANGELOG.md', '/repo/CHANGELOG.md']
 */
export function candidatePaths(filePath, cwd, root = repoRoot) {
  if (!filePath) {
    return [];
  }

  if (isAbsolute(filePath)) {
    return [resolve(filePath)];
  }

  const fromCwd = resolve(cwd, filePath);
  return isInsideRepo(cwd, root) ? [fromCwd, resolve(root, filePath)] : [fromCwd];
}

async function resolveTouchedPath(input) {
  const candidates = candidatePaths(extractTouchedFilePath(input), extractHookCwd(input));

  for (const candidate of candidates) {
    if (await isExistingFile(candidate)) {
      return candidate;
    }
  }

  return '';
}

/**
 * Check whether a resolved file path belongs to the current repository.
 * // Usage: if (!isInsideRepo(filePath)) return;
 */
export function isInsideRepo(filePath, root = repoRoot) {
  const relativePath = relative(root, filePath);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

/**
 * Exclude generated, dependency, and build output files from hook formatting.
 * // Usage: if (shouldSkipFile(filePath)) return;
 */
export function shouldSkipFile(filePath) {
  const normalizedPath = normalizePath(filePath).toLowerCase();
  return (
    ignoredSegments.some((segment) => normalizedPath.includes(segment)) ||
    normalizedPath.endsWith('/.tsbuildinfo') ||
    normalizedPath.endsWith('/bun.lock') ||
    normalizedPath.endsWith('/routetree.gen.ts')
  );
}

/**
 * Select the formatter that owns a touched file.
 * // Usage: const formatter = chooseFormatter(filePath);
 */
export function chooseFormatter(filePath) {
  const extension = extname(filePath).toLowerCase();

  if (biomeExtensions.has(extension)) {
    return 'biome';
  }

  if (dprintExtensions.has(extension) || isDockerfile(filePath)) {
    return 'dprint';
  }

  if (extension === '.rs') {
    return 'rustfmt';
  }

  return undefined;
}

/**
 * Format the touched file described by a hook payload when it is safe to do so.
 * // Usage: await runAutoFixHook(input);
 */
export async function runAutoFixHook(input) {
  const hookInput = input ?? (await readStdin());
  const filePath = await resolveTouchedPath(hookInput);

  if (!filePath || !isInsideRepo(filePath) || shouldSkipFile(filePath)) {
    return;
  }

  const formatter = chooseFormatter(filePath);

  if (formatter === 'biome') {
    await runBiome(filePath);
  }

  if (formatter === 'dprint') {
    await runDprint(filePath);
  }

  if (formatter === 'rustfmt') {
    await runRustfmt(filePath);
  }
}

function parseHookInput(input) {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function isDockerfile(filePath) {
  return basename(filePath).toLowerCase().startsWith('dockerfile');
}

async function isExistingFile(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function runBiome(filePath) {
  await runFormatter([
    process.execPath,
    'x',
    '--no-install',
    'biome',
    'check',
    '--write',
    '--no-errors-on-unmatched',
    '--files-ignore-unknown=true',
    filePath,
  ]);
}

async function runDprint(filePath) {
  await runFormatter([
    process.execPath,
    'x',
    '--no-install',
    'dprint',
    'fmt',
    '--allow-no-files',
    filePath,
  ]);
}

// rustfmt reads the edition and style from the nearest rustfmt.toml.
async function runRustfmt(filePath) {
  await runFormatter(['rustfmt', filePath]);
}

async function runFormatter(command) {
  try {
    const formatter = Bun.spawn(command, {
      cwd: repoRoot,
      stderr: 'ignore',
      stdout: 'ignore',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    await formatter.exited;
  } catch {
    // Hook formatting should never block the agent workflow.
  }
}

async function readStdin() {
  return await new Response(Bun.stdin.stream()).text();
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runAutoFixHook();
}
