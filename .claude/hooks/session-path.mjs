import { access, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the Claude env-file export that prepends repo-local binaries.
 * // Usage: const line = createPathExportLine(repoBin);
 */
export function createPathExportLine(repoBin, pathDelimiter = delimiter) {
  return `export PATH=${quoteShellValue(`${repoBin}${pathDelimiter}`)}"$PATH"\n`;
}

/**
 * Resolve the project-owned binary directory used by local tool commands.
 * // Usage: const repoBin = resolveRepoBin(projectDir);
 */
export function resolveRepoBin(projectDir) {
  return projectDir ? join(projectDir, 'node_modules', '.bin') : '';
}

/**
 * Persist the repo-local binary path for subsequent Claude commands.
 * // Usage: await updateClaudeEnvPath(process.env);
 */
export async function updateClaudeEnvPath(env = process.env) {
  const envFile = env.CLAUDE_ENV_FILE;
  const repoBin = resolveRepoBin(env.CLAUDE_PROJECT_DIR);

  if (!envFile || !(await directoryExists(repoBin))) {
    return;
  }

  await writeFile(envFile, createPathExportLine(repoBin), 'utf8');
}

function quoteShellValue(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function directoryExists(path) {
  if (!path) {
    return false;
  }

  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await updateClaudeEnvPath();
}
