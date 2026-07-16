/**
 * First-run auth secret setup for `mangostudio serve`.
 * Generates one strong secret only when none is configured, then persists it
 * before the server imports Better Auth.
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  getAuthSecretValidationMessage,
  getConfig,
  getConfigEnvFilePath,
  resetConfig,
} from '../lib/config';
import { readUtf8FileOrNull, SECRET_FILE_MODE, writeFileAtomic } from '../lib/safe-file';
import { CliError } from './errors';
import { writeLine } from './output';

export type AuthSecretStorageTarget = 'env' | 'toml';

interface AuthSecretStorageOptions {
  envPath: string;
  tomlPath: string;
}

export interface AuthSecretSetupDeps {
  askStorageTarget?: (options: AuthSecretStorageOptions) => Promise<AuthSecretStorageTarget>;
  generateSecret?: () => string;
  isInteractive?: () => boolean;
  log?: (message: string) => void;
}

/** Ensure `serve` has a usable Better Auth secret. // Usage: await ensureServeAuthSecret() */
export async function ensureServeAuthSecret(deps: AuthSecretSetupDeps = {}): Promise<void> {
  const config = getConfig();
  const message = getAuthSecretValidationMessage(config.auth.secret);
  if (!message) return;

  const options = getStorageOptions();
  if (config.auth.secret.trim()) throw new CliError(buildManualSetupMessage(message, options));
  if (!isInteractive(deps)) throw new CliError(buildInteractiveSetupMessage(message, options));

  const secret = getGeneratedSecret(deps);
  const target = await (deps.askStorageTarget ?? askStorageTarget)(options);
  persistGeneratedSecret(target, secret, options);
  process.env.BETTER_AUTH_SECRET = secret;
  resetConfig();
  reportStoredSecret(target, options, deps.log ?? writeLine);
}

function getStorageOptions(): AuthSecretStorageOptions {
  const tomlPath = getConfig().configFilePath;
  return { envPath: getConfigEnvFilePath(tomlPath), tomlPath };
}

function buildManualSetupMessage(message: string, options: AuthSecretStorageOptions): string {
  return `${message} Set BETTER_AUTH_SECRET in ${options.envPath} or auth.secret in ${options.tomlPath}.`;
}

function buildInteractiveSetupMessage(message: string, options: AuthSecretStorageOptions): string {
  return `${buildManualSetupMessage(message, options)} Run mangostudio serve in an interactive terminal to generate one automatically.`;
}

function isInteractive(deps: AuthSecretSetupDeps): boolean {
  return deps.isInteractive?.() ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function getGeneratedSecret(deps: AuthSecretSetupDeps): string {
  const secret = deps.generateSecret?.() ?? generateAuthSecret();
  const message = getAuthSecretValidationMessage(secret);
  if (message) throw new Error(`Generated invalid auth secret: ${message}`);
  return secret;
}

function generateAuthSecret(): string {
  return randomBytes(32).toString('base64url');
}

async function askStorageTarget(
  options: AuthSecretStorageOptions
): Promise<AuthSecretStorageTarget> {
  printStoragePrompt(options);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readStorageTarget(rl);
  } finally {
    rl.close();
  }
}

function printStoragePrompt(options: AuthSecretStorageOptions): void {
  writeLine('BETTER_AUTH_SECRET is missing. MangoStudio generated a new strong secret.');
  writeLine(`1. .env (recommended for secrets): ${options.envPath}`);
  writeLine(`2. config.toml: ${options.tomlPath}`);
}

async function readStorageTarget(rl: {
  question(prompt: string): Promise<string>;
}): Promise<AuthSecretStorageTarget> {
  while (true) {
    const choice = parseStorageTarget(
      await rl.question('Where should MangoStudio store it? [1]: ')
    );
    if (choice) return choice;
    writeLine('Please choose 1 for .env or 2 for config.toml.');
  }
}

function parseStorageTarget(answer: string): AuthSecretStorageTarget | null {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === '.env' || normalized === 'env') {
    return 'env';
  }
  if (normalized === '2' || normalized === 'toml' || normalized === 'config.toml') {
    return 'toml';
  }
  return null;
}

function persistGeneratedSecret(
  target: AuthSecretStorageTarget,
  secret: string,
  options: AuthSecretStorageOptions
): void {
  const path = target === 'env' ? options.envPath : options.tomlPath;
  try {
    if (target === 'env') persistEnvSecret(path, secret);
    if (target === 'toml') persistTomlSecret(path, secret);
  } catch (error) {
    throw new CliError(`Failed to write auth secret to ${path}: ${getErrorMessage(error)}`);
  }
}

function persistEnvSecret(filePath: string, secret: string): void {
  const current = readUtf8FileOrNull(filePath) ?? '';
  writeFileAtomic(filePath, upsertEnvValue(current, secret), { mode: SECRET_FILE_MODE });
}

function upsertEnvValue(content: string, secret: string): string {
  const entry = `BETTER_AUTH_SECRET="${secret}"`;
  if (!content.trim()) return `${entry}\n`;

  const lines = content.split(/\r?\n/);
  const replaced = replaceEnvSecretLine(lines, entry);
  if (!replaced) insertEnvSecretLine(lines, entry);
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function replaceEnvSecretLine(lines: string[], entry: string): boolean {
  let replaced = false;
  for (const [index, line] of lines.entries()) {
    if (!/^\s*BETTER_AUTH_SECRET\s*=/.test(line)) continue;
    lines[index] = entry;
    replaced = true;
  }
  return replaced;
}

function insertEnvSecretLine(lines: string[], entry: string): void {
  if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, entry);
  else lines.push(entry);
}

function persistTomlSecret(filePath: string, secret: string): void {
  const config = readTomlRecord(filePath);
  const auth = isRecord(config.auth) ? { ...config.auth } : {};
  auth.secret = secret;
  config.auth = auth;
  writeFileAtomic(filePath, stringifyToml(config), { mode: SECRET_FILE_MODE });
}

function readTomlRecord(filePath: string): Record<string, unknown> {
  const content = readUtf8FileOrNull(filePath);
  if (content === null) return {};
  const parsed = parseToml(content);
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportStoredSecret(
  target: AuthSecretStorageTarget,
  options: AuthSecretStorageOptions,
  log: (message: string) => void
): void {
  const path = target === 'env' ? options.envPath : options.tomlPath;
  log(`Saved generated BETTER_AUTH_SECRET to ${path}.`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
