import { renameSync, writeFileSync } from 'node:fs';

import { checkerDiagnostic } from './lib/ci-check-evidence';
import { runCapture } from './qa-gate/collect/support';

/**
 * Capture one checker inside the parent's supervised worker group and publish its diagnostic receipt.
 * @example await writeTypeScriptReceipt('apps/api', '/tmp/result.json', invocationId);
 */
export async function writeTypeScriptReceipt(
  root: string,
  path: string,
  invocationId: string,
  run: typeof runCapture = runCapture
): Promise<number> {
  let diagnostic;
  let exitCode = 1;
  try {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(root))
      throw new Error(
        `TypeScript root: expected component directory; received ${JSON.stringify(root)}`
      );
    const output = await run([
      'bun',
      'check',
      '--no-script',
      '--all',
      '--no-pretty',
      '-p',
      `${root}/tsconfig.json`,
    ]);
    process.stdout.write(output.stdout);
    process.stderr.write(output.stderr);
    diagnostic = checkerDiagnostic(root, output);
    exitCode = diagnostic.state === 'unavailable' ? 1 : output.exitCode;
  } catch (caught) {
    diagnostic = {
      root,
      state: 'unavailable' as const,
      reason: (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000),
    };
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ invocationId, diagnostic, exitCode }), { mode: 0o600 });
  renameSync(temporary, path);
  return exitCode;
}

if (import.meta.main) {
  const [root, path, invocationId, ...extra] = process.argv.slice(2);
  if (!root || !path || !invocationId || extra.length)
    throw new Error('expected <component-root> <receipt-path> <invocation-id>');
  process.exit(await writeTypeScriptReceipt(root, path, invocationId));
}
