/**
 * Hermetic Cursor sidecar fixture for binary smoke tests.
 *
 * Creates a temp directory with a minimal Node sidecar script (no @cursor/sdk)
 * and stub node_modules so runtime availability probes pass without network.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cursorNativePackageForArch, cursorSidecarPackageTreeErrors } from './cursor-sidecar';
import type { ReleasePlatformId } from './release-targets';

export interface CursorSmokeSidecarFixture {
  readonly rootDir: string;
  readonly sidecarScriptPath: string;
  cleanup(): void;
}

const FAKE_SIDECAR_SOURCE = `import { createInterface } from 'node:readline';

// Mirrors PROTOCOL_VERSION in apps/api/src/services/providers/cursor/sidecar/run-agent.mjs.
console.log(JSON.stringify({ type: 'ready', protocolVersion: 1 }));

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    console.log(JSON.stringify({
      type: 'error',
      message: 'Sidecar request must be valid JSON.',
      content: 'Sidecar request must be valid JSON.',
      done: true,
    }));
    process.exitCode = 1;
    rl.close();
    return;
  }

  if (request.type === 'validate_api_key') {
    console.log(JSON.stringify({
      type: 'error',
      message: 'Cursor API key rejected',
      content: 'Cursor API key rejected',
      status: 401,
      isRetryable: false,
      retryable: false,
      done: true,
    }));
    process.exitCode = 1;
    rl.close();
    return;
  }

  console.log(JSON.stringify({
    type: 'error',
    message: \`Unsupported Cursor sidecar request type "\${request.type ?? 'unknown'}".\`,
    content: \`Unsupported Cursor sidecar request type "\${request.type ?? 'unknown'}".\`,
    done: true,
  }));
  process.exitCode = 1;
  rl.close();
});
`;

function writeStubSdkPackage(nodeModulesDir: string): void {
  const sdkDir = join(nodeModulesDir, '@cursor', 'sdk');
  mkdirSync(join(sdkDir, 'dist', 'cjs'), { recursive: true });
  mkdirSync(join(sdkDir, 'dist', 'esm'), { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: '@cursor/sdk' }));
  writeFileSync(join(sdkDir, 'dist', 'cjs', '642.js'), '');
  writeFileSync(join(sdkDir, 'dist', 'esm', '642.js'), '');
}

function writeStubNativePackage(nodeModulesDir: string, packageName: string): void {
  const packageDir = join(nodeModulesDir, ...packageName.split('/'));
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, bin: { rg: `bin/${rgName}` } })
  );
  writeFileSync(join(packageDir, 'bin', rgName), 'rg');
}

/** Creates a hermetic fake Cursor sidecar tree for smoke and fixture tests. */
export function createCursorSmokeSidecarFixture(
  platformArch: ReleasePlatformId
): CursorSmokeSidecarFixture {
  const nativePackage = cursorNativePackageForArch(platformArch);
  if (!nativePackage) {
    throw new Error(`Platform ${platformArch} does not ship a Cursor sidecar.`);
  }

  const rootDir = mkdtempSync(join(tmpdir(), 'mangostudio-cursor-smoke-'));
  const sidecarScriptPath = join(rootDir, 'run-agent.mjs');
  writeFileSync(sidecarScriptPath, FAKE_SIDECAR_SOURCE);

  const nodeModulesDir = join(rootDir, 'node_modules');
  writeStubSdkPackage(nodeModulesDir);
  writeStubNativePackage(nodeModulesDir, nativePackage);

  const layoutErrors = cursorSidecarPackageTreeErrors(rootDir, nativePackage);
  if (layoutErrors.length > 0) {
    rmSync(rootDir, { force: true, recursive: true });
    throw new Error(`Cursor smoke sidecar fixture is incomplete:\n- ${layoutErrors.join('\n- ')}`);
  }

  return {
    rootDir,
    sidecarScriptPath,
    cleanup() {
      rmSync(rootDir, { force: true, recursive: true });
    },
  };
}

/** Runs the fake sidecar once and returns parsed stdout lines. */
export async function runCursorSmokeSidecarProtocol(
  sidecarScriptPath: string,
  request: Record<string, unknown>
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Array<Record<string, unknown>>;
  stderr: string;
}> {
  const child = spawn('node', [sidecarScriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.stdin.end(`${JSON.stringify(request)}\n`);

  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }
  );

  return {
    ...status,
    stdout: stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    stderr,
  };
}
