import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleaseTag } from '../release/verify-release-tag';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks, runScriptLines } from './support/workflow-blocks';

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
  for (const path of ['.github', 'scripts/lib', 'scripts/release']) {
    await mkdir(join(directory, path), { recursive: true });
  }
  for (const path of [
    '.bun-version',
    'bunfig.toml',
    'scripts/lib/config.ts',
    'scripts/lib/release-version.ts',
    'scripts/lib/cargo-version.ts',
    'scripts/release/verify-release-tag.ts',
  ]) {
    await writeFile(join(directory, path), readText(path));
  }
  await writeFile(join(directory, '.github/release-allowed-signers'), await readFile(signers));
  fixtureCommand(['git', 'add', '.github', '.bun-version', 'bunfig.toml', 'scripts']);
  fixtureCommand(['git', 'commit', '-m', 'Trusted release verifier']);
  fixtureCommand(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
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

  test('rejects a signed tag whose name differs from the requested release', async () => {
    await expect(
      verifyReleaseTag('v1.0.0', { ...options(), expectedTag: 'v9.9.9' })
    ).rejects.toThrow('Tag "v1.0.0" does not match the release; expected v9.9.9');
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

  test('the workflow rejects a candidate verifier, signer policy and Bun preload bypass', async () => {
    const archive = await mkdtemp(join(tmpdir(), 'release-policy-archive-'));
    try {
      await writeFile(
        join(directory, '.github/release-allowed-signers'),
        `fixture@example.test namespaces="git" ${await readFile(`${otherKey}.pub`, 'utf8')}`
      );
      await writeFile(
        join(directory, 'scripts/release/verify-release-tag.ts'),
        'console.log("Candidate bypassed verification");\n'
      );
      await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
      await writeFile(
        join(directory, 'preload.ts'),
        'console.log("Candidate preload bypass"); process.exit(0);\n'
      );
      fixtureCommand(['git', 'add', '.github', 'scripts', 'bunfig.toml', 'preload.ts']);
      fixtureCommand(['git', 'commit', '-m', 'Untrusted candidate replaces release policy']);
      fixtureCommand([
        'git',
        '-c',
        `user.signingkey=${otherKey}`,
        'tag',
        '-s',
        'v1.0.5',
        '-m',
        'Untrusted',
      ]);
      const block = extractJobBlock(readText('.github/workflows/release.yml'), 'prepare');
      const steps = extractStepBlocks(block);
      const load = steps.find((step) => step.includes('name: Load the release verifier'));
      const verify = steps.find((step) => step.includes('name: Verify the trusted release tag'));
      expect(load).toBeDefined();
      expect(verify).toBeDefined();
      const env = {
        ...process.env,
        // Git Bash needs shell-readable paths when the fixture runs on Windows.
        RUNNER_TEMP: archive.replaceAll('\\', '/'),
        GITHUB_WORKSPACE: directory.replaceAll('\\', '/'),
        RELEASE_TAG: 'v1.0.5',
        RELEASE_REF_TYPE: 'tag',
        EXPECTED_RELEASE_TAG: 'v1.0.5',
      };
      for (const step of [load, verify]) {
        const script = runScriptLines(step ?? '')
          .map(({ text }) => text.trimStart())
          .join('\n');
        const result = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', script], {
          cwd: directory,
          env,
        });
        if (step === load) {
          expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
          continue;
        }
        expect(result.exitCode).toBe(1);
        expect(new TextDecoder().decode(result.stderr)).toContain('failed signature verification');
        expect(new TextDecoder().decode(result.stdout)).not.toContain(
          'Candidate bypassed verification'
        );
        expect(new TextDecoder().decode(result.stdout)).not.toContain('Candidate preload bypass');
      }
    } finally {
      fixtureCommand(['git', 'reset', '--hard', 'refs/remotes/origin/main']);
      await rm(archive, { recursive: true, force: true });
    }
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
      expect(block).toContain(
        'bun --no-env-file "$RUNNER_TEMP/release-trust/scripts/release/verify-release-tag.ts" "$RELEASE_TAG" "$GITHUB_WORKSPACE" "$EXPECTED_RELEASE_TAG"'
      );
      expect(block).not.toContain('continue-on-error:');
      const verification = extractStepBlocks(block).find((step) =>
        step.includes('verify-release-tag.ts')
      );
      expect(verification).toContain('RELEASE_TAG:');
      expect(verification).toContain('cd "$RUNNER_TEMP/release-trust"');
      expect(verification).not.toContain('allow_unverified_source');
    }
  });

  test('gets verifier code and policy from protected main before executing tagged code', () => {
    for (const [file, job] of [
      ['release.yml', 'prepare'],
      ['protocol-release.yml', 'verify'],
    ] as const) {
      const block = extractJobBlock(readText(`.github/workflows/${file}`), job);
      expect(block).toContain('git archive refs/remotes/origin/main');
      expect(block).toContain('bun-version-file: ${{ runner.temp }}/release-trust/.bun-version');
      const verification = block.indexOf('bun --no-env-file "$RUNNER_TEMP/release-trust/scripts/');
      expect(verification).toBeGreaterThan(-1);
      expect(verification).toBeLessThan(
        block.indexOf(
          file === 'release.yml' ? 'uses: ./.github/actions/setup-mango' : 'bun install'
        )
      );
    }
  });

  test('binds the resolved app version to a tag ref before signature verification', () => {
    const block = extractJobBlock(readText('.github/workflows/release.yml'), 'prepare');
    expect(block).toContain('RELEASE_REF_TYPE: ${{ github.ref_type }}');
    expect(block).toContain('EXPECTED_RELEASE_TAG: v${{ steps.resolve.outputs.version }}');
    expect(block).toContain('[ "$RELEASE_REF_TYPE" != "tag" ]');
    expect(block).toContain('"$RELEASE_TAG" != "$EXPECTED_RELEASE_TAG"');
    expect(block.indexOf('id: resolve')).toBeLessThan(block.indexOf('EXPECTED_RELEASE_TAG:'));
  });

  test('the stable publisher requires the verified tag to already exist on GitHub', () => {
    const block = extractJobBlock(readText('.github/workflows/release.yml'), 'github-release');
    const publication = extractStepBlocks(block).find((step) => step.includes('publish_release'));
    expect(publication).toContain('--verify-tag');
  });

  test('release dry-run runs cryptographic acceptance and rejection fixtures', () => {
    const workflow = readText('.github/workflows/release-dry-run.yml');
    expect(extractJobBlock(workflow, 'changes')).toContain(
      'bun test scripts/tests/verify-release-tag.unit.test.ts'
    );
  });
});
