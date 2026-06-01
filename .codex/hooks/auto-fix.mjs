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

  return undefined;
}

/**
 * Format the touched file described by a hook payload when it is safe to do so.
 * // Usage: await runAutoFixHook(input);
 */
export async function runAutoFixHook(input) {
  const hookInput = input ?? (await readStdin());
  const filePath = resolveTouchedPath(extractTouchedFilePath(hookInput));

  if (!(await isExistingFile(filePath)) || !isInsideRepo(filePath) || shouldSkipFile(filePath)) {
    return;
  }

  const formatter = chooseFormatter(filePath);

  if (formatter === 'biome') {
    await runBiome(filePath);
  }

  if (formatter === 'dprint') {
    await runDprint(filePath);
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

function resolveTouchedPath(filePath) {
  if (!filePath) {
    return '';
  }

  return isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
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
  await runFormatter(['x', '--no-install', 'dprint', 'fmt', '--allow-no-files', filePath]);
}

async function runFormatter(args) {
  try {
    await new Promise((resolveProcess) => {
      Bun.spawn([process.execPath, ...args], {
        cwd: repoRoot,
        stderr: 'ignore',
        stdout: 'ignore',
        onExit: resolveProcess,
      });
    });
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
