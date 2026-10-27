import { stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { extname, isAbsolute, relative, resolve } from 'node:path';
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
const bunLintExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const bunFormatExtensions = new Set([
  ...bunLintExtensions,
  '.json',
  '.jsonc',
  '.css',
  '.html',
  '.md',
  '.mdc',
  '.mdx',
  '.toml',
  '.yml',
  '.yaml',
]);

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

  if (bunLintExtensions.has(extension)) {
    return 'bun';
  }

  if (bunFormatExtensions.has(extension)) {
    return 'fmt';
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

  if (formatter === 'bun') {
    await runBunLint(filePath);
    await runBunFormat(filePath);
  }

  if (formatter === 'fmt') {
    await runBunFormat(filePath);
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

async function runBunLint(filePath) {
  await runFormatter([process.execPath, 'lint', '--fix', '--no-script', filePath]);
}

async function runBunFormat(filePath) {
  await runFormatter([process.execPath, 'fmt', filePath]);
}

// rustfmt reads the edition and style from the nearest rustfmt.toml.
async function runRustfmt(filePath) {
  await runFormatter(['rustfmt', filePath]);
}

const formatterTimeoutMs = 5000;
const cancelSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// A formatter may be a proxy (rustup, `bun x`) whose real process is a grandchild, so the
// deadline stops the whole tree: its own process group on POSIX, `taskkill /T` on Windows,
// where `detached` would only let the tree escape Bun's job object. On POSIX that group no
// longer receives the signal an agent sends to cancel the hook, so the hook forwards it.
async function runFormatter(command) {
  let formatter;
  let deadline;
  let cancellationSignal;
  let stopRequested = false;
  const requestStop = () => {
    if (!formatter || stopRequested) return;
    stopRequested = true;
    stopFormatterTree(formatter);
  };
  const onCancel = (signal) => {
    if (cancellationSignal) return;
    cancellationSignal = signal;
    if (deadline !== undefined) clearTimeout(deadline);
    requestStop();
  };
  // Own cancellation before the child can run, including a signal received
  // while spawn is still transferring the native handle back to this hook.
  const forwarded = process.platform === 'win32' ? [] : cancelSignals;
  const listeners = forwarded.map((signal) => {
    const listener = () => onCancel(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    try {
      formatter = Bun.spawn(command, {
        cwd: repoRoot,
        stderr: 'ignore',
        stdout: 'ignore',
        detached: process.platform !== 'win32',
      });
    } catch {
      // Hook formatting should never block the agent workflow.
      return;
    }
    if (cancellationSignal) requestStop();
    else deadline = setTimeout(requestStop, formatterTimeoutMs);
    await formatter.exited;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    for (const { signal, listener } of listeners) process.off(signal, listener);
    if (cancellationSignal) process.exit(128 + constants.signals[cancellationSignal]);
  }
}

function stopFormatterTree(formatter) {
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(formatter.pid)], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } else {
      process.kill(-formatter.pid, 'SIGKILL');
    }
  } catch {
    // The tree already exited.
  }
  try {
    // The formatter itself must stop even when the tree could not be reached.
    formatter.kill('SIGKILL');
  } catch {
    // Already stopped.
  }
}

async function readStdin() {
  return await new Response(Bun.stdin.stream()).text();
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runAutoFixHook();
}
