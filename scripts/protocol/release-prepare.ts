/**
 * `bun run protocol:release:prepare <version>`: moves every protocol manifest
 * to one version, refreshes Cargo.lock, and regenerates
 * `packages/protocol/CHANGELOG.md` with the new tag applied to the unreleased
 * commits. Nothing is committed or tagged; the printed commands do that after
 * review.
 *
 * The tag is `protocol-v<version>`, not `v<version>`: the application's release
 * train owns the bare `v*` tags and `.github/workflows/release.yml` fires on
 * them.
 *
 * @example
 * bun run protocol:release:prepare 0.2.1
 */

import { ROOT_DIR } from '../lib/config';
import { PROTOCOL_CHANGELOG, PROTOCOL_CLIFF_CONFIG, protocolTag } from '../lib/protocol';
import { fatal, runCommand, runSequential } from '../lib/runner';
import { assertLockstep, readVersions, writeVersions } from './versions';

const version = process.argv[2];
if (!version) {
  fatal('Usage: bun run protocol:release:prepare <version>');
}

const tag = protocolTag(version);

await writeVersions(version);
const results = await runSequential([
  () => runCommand('cargo update -w', ['cargo', 'update', '--workspace'], { cwd: ROOT_DIR }),
  () =>
    runCommand(
      'git-cliff',
      [
        'bunx',
        'git-cliff',
        '--config',
        PROTOCOL_CLIFF_CONFIG,
        '--tag',
        tag,
        // Prepend the new section; never regenerate the file. The 0.1.0 and
        // 0.2.0 sections were generated upstream, before the tree moved into
        // this repository, and cannot be reproduced from here: those commits
        // carry the upstream root-relative paths. See the note at the bottom of
        // packages/protocol/cliff.toml.
        '--unreleased',
        '--prepend',
        PROTOCOL_CHANGELOG,
      ],
      { cwd: ROOT_DIR }
    ),
]);
if (results.some((result) => result.exitCode !== 0)) process.exit(1);
assertLockstep(await readVersions(), version);

console.log(`
Prepared ${version}. Review the diff, then:

  git add -A && git commit -m "chore(release): ${tag}"
  git tag -s ${tag} -m "${tag}"
  git push origin main ${tag}
`);
