import { resolve } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { isValidSemver, normalizeVersion } from '../lib/release-version';

interface VerificationOptions {
  readonly cwd?: string;
  readonly allowedSignersFile?: string;
  readonly expectedTag?: string;
}

/**
 * Require an annotated app or protocol tag at HEAD signed by the release trust policy.
 * @example await verifyReleaseTag('v0.2.0');
 */
export async function verifyReleaseTag(
  tag: string,
  {
    cwd = ROOT_DIR,
    allowedSignersFile = resolve(ROOT_DIR, '.github/release-allowed-signers'),
    expectedTag,
  }: VerificationOptions = {}
): Promise<{ tag: string; commit: string }> {
  const version = tag.replace(/^(?:protocol-v|v)/, '');
  if (
    !/^(?:protocol-v|v)/.test(tag) ||
    normalizeVersion(version) !== version ||
    !isValidSemver(version)
  ) {
    throw new Error(`Invalid tag ${JSON.stringify(tag)}; expected v<semver> or protocol-v<semver>`);
  }
  if (expectedTag !== undefined && tag !== expectedTag) {
    throw new Error(
      `Tag ${JSON.stringify(tag)} does not match the release; expected ${expectedTag}`
    );
  }
  const ref = `refs/tags/${tag}`;
  const type = Bun.spawnSync(['git', 'cat-file', '-t', ref], { cwd });
  if (type.exitCode !== 0 || new TextDecoder().decode(type.stdout).trim() !== 'tag') {
    throw new Error(`Invalid tag ${JSON.stringify(tag)}; expected an annotated signed release tag`);
  }
  const object = Bun.spawnSync(['git', 'cat-file', 'tag', ref], { cwd });
  const signedName = new TextDecoder()
    .decode(object.stdout)
    .split('\n\n', 1)[0]
    .split('\n')
    .find((line) => line.startsWith('tag '))
    ?.slice(4);
  if (object.exitCode !== 0 || signedName !== tag) {
    throw new Error(
      `Tag ${JSON.stringify(tag)} signed object names ${signedName ?? 'no tag'}; expected ${tag}`
    );
  }
  const resolved = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], { cwd });
  const tagged = Bun.spawnSync(['git', 'rev-parse', '--verify', `${ref}^{commit}`], { cwd });
  const commit = new TextDecoder().decode(resolved.stdout).trim();
  const received = new TextDecoder().decode(tagged.stdout).trim();
  if (resolved.exitCode !== 0 || tagged.exitCode !== 0 || received !== commit) {
    throw new Error(
      `Tag ${JSON.stringify(tag)} points to ${received || 'no commit'}; expected checked-out HEAD ${commit || 'to resolve'}`
    );
  }
  const policyPath = resolve(cwd, allowedSignersFile);
  const policy = await Bun.file(policyPath)
    .text()
    .catch((error: unknown) => {
      throw new Error(
        `Invalid signer policy ${JSON.stringify(policyPath)}; expected a readable SSH allowed-signers file`,
        { cause: error }
      );
    });
  const principals = policy
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s/, 1)[0])
    .join(', ');
  const verification = Bun.spawn(
    [
      'git',
      '-c',
      'gpg.format=ssh',
      '-c',
      `gpg.ssh.allowedSignersFile=${policyPath}`,
      '-c',
      'gpg.ssh.program=ssh-keygen',
      'verify-tag',
      '--raw',
      '--',
      ref,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  );
  const [exitCode, details] = await Promise.all([
    verification.exited,
    new Response(verification.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Tag ${JSON.stringify(tag)} failed signature verification; expected an SSH signer ${principals || 'listed in the policy'}, trusted by ${policyPath}. Received: ${details.trim()}`
    );
  }
  return { tag, commit };
}

if (import.meta.main) {
  try {
    const receipt = await verifyReleaseTag(Bun.argv[2] ?? '', {
      cwd: Bun.argv[3] ?? ROOT_DIR,
      expectedTag: Bun.argv[4],
    });
    console.log(`Verified trusted release tag ${receipt.tag} at ${receipt.commit}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
