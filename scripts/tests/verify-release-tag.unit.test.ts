import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleaseTag } from '../release/verify-release-tag';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

let directory: string;
let trustedKey: string;
let otherKey: string;
let signers: string;

/** Run isolated Git/SSH fixture setup, failing before the tested assertion if setup breaks. */
function fixtureCommand(args: string[]): string {
  const result = Bun.spawnSync(args, { cwd: directory });
  if (result.exitCode !== 0) {
    throw new Error(
      `Fixture command ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'trusted-release-tag-'));
  trustedKey = join(directory, 'trusted');
  otherKey = join(directory, 'other');
  signers = join(directory, 'allowed-signers');
  fixtureCommand(['git', 'init', '--initial-branch=main']);
  fixtureCommand(['git', 'config', 'user.name', 'Release fixture']);
  fixtureCommand(['git', 'config', 'user.email', 'fixture@example.test']);
  fixtureCommand(['git', 'config', 'commit.gpgsign', 'false']);
  fixtureCommand(['git', 'config', 'gpg.format', 'ssh']);
  fixtureCommand(['git', 'config', 'gpg.ssh.program', 'ssh-keygen']);
  fixtureCommand(['git', 'config', 'tag.gpgsign', 'false']);
  fixtureCommand(['git', 'commit', '--allow-empty', '-m', 'Fixture']);
  for (const key of [trustedKey, otherKey]) {
    fixtureCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  }
  await writeFile(
    signers,
    `fixture@example.test namespaces="git" ${await readFile(`${trustedKey}.pub`, 'utf8')}`
  );
  fixtureCommand([
    'git',
    '-c',
    `user.signingkey=${trustedKey}`,
    'tag',
    '-s',
    'v1.0.0',
    '-m',
    'Trusted',
  ]);
  fixtureCommand([
    'git',
    '-c',
    `user.signingkey=${trustedKey}`,
    'tag',
    '-s',
    'protocol-v1.0.0',
    '-m',
    'Trusted protocol',
  ]);
  fixtureCommand([
    'git',
    '-c',
    `user.signingkey=${otherKey}`,
    'tag',
    '-s',
    'v1.0.1',
    '-m',
    'Other signer',
  ]);
  fixtureCommand(['git', 'tag', '-a', 'v1.0.2', '-m', 'Unsigned']);
  fixtureCommand(['git', 'tag', 'v1.0.3']);
  fixtureCommand(['git', 'update-ref', 'refs/tags/v1.0.4', 'refs/tags/v1.0.0']);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('trusted release tag verification', () => {
  const options = () => ({ cwd: directory, allowedSignersFile: signers });

  test('verifies both release trains against the explicit SSH trust file', async () => {
    const commit = fixtureCommand(['git', 'rev-parse', 'HEAD']);
    for (const tag of ['v1.0.0', 'protocol-v1.0.0']) {
      expect(await verifyReleaseTag(tag, options())).toEqual({ tag, commit });
    }
  });

  test('rejects a signature from another key despite local Git trust', async () => {
    const unrelatedTrust = join(directory, 'unrelated-trust');
    await writeFile(
      unrelatedTrust,
      `fixture@example.test ${await readFile(`${otherKey}.pub`, 'utf8')}`
    );
    fixtureCommand(['git', 'config', 'gpg.ssh.allowedSignersFile', unrelatedTrust]);
    await expect(verifyReleaseTag('v1.0.1', options())).rejects.toThrow(
      'Tag "v1.0.1" failed signature verification; expected an SSH signer fixture@example.test, trusted by'
    );
  });

  test('rejects unsigned annotated and lightweight tags', async () => {
    await expect(verifyReleaseTag('v1.0.2', options())).rejects.toThrow(
      'failed signature verification'
    );
    await expect(verifyReleaseTag('v1.0.3', options())).rejects.toThrow(
      'expected an annotated signed release tag'
    );
  });

  test('rejects a trusted signature reused under another release name', async () => {
    await expect(verifyReleaseTag('v1.0.4', options())).rejects.toThrow(
      'signed object names v1.0.0; expected v1.0.4'
    );
  });

  test('rejects a missing trust file and a signed tag pointing at another checkout', async () => {
    await expect(
      verifyReleaseTag('v1.0.0', { ...options(), allowedSignersFile: join(directory, 'absent') })
    ).rejects.toThrow('expected a readable SSH allowed-signers file');
    fixtureCommand(['git', 'commit', '--allow-empty', '-m', 'Different checkout']);
    await expect(verifyReleaseTag('v1.0.0', options())).rejects.toThrow(
      'expected checked-out HEAD'
    );
    fixtureCommand(['git', 'reset', '--hard', 'HEAD~1']);
  });

  test.each(['', 'main', 'vv1.2.3', 'v01.2.3', 'protocol-v1.2.3 ', 'v1.2.3\nignored'])(
    'rejects malformed release ref %j',
    async (tag) => {
      await expect(verifyReleaseTag(tag, options())).rejects.toThrow(
        'expected v<semver> or protocol-v<semver>'
      );
    }
  );
});

describe('release signature gates', () => {
  test('both publication trains verify trust before their publishing dependencies can start', () => {
    for (const [file, job] of [
      ['release.yml', 'prepare'],
      ['protocol-release.yml', 'verify'],
    ] as const) {
      const workflow = readText(`.github/workflows/${file}`);
      const block = extractJobBlock(workflow, job);
      expect(block).toContain('bun ./scripts/release/verify-release-tag.ts "$RELEASE_TAG"');
      expect(block).not.toContain('continue-on-error:');
      const verification = extractStepBlocks(block).find((step) =>
        step.includes('verify-release-tag.ts')
      );
      expect(verification).toContain('RELEASE_TAG:');
      expect(verification).not.toContain('allow_unverified_source');
    }
  });

  test('release dry-run runs cryptographic acceptance and rejection fixtures', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    expect(extractJobBlock(workflow, 'changes')).toContain(
      'bun test scripts/tests/verify-release-tag.unit.test.ts'
    );
  });
});
