/**
 * `bun run release:prepare <version>`: moves every manifest to one version,
 * refreshes Cargo.lock, and regenerates CHANGELOG.md with the new tag applied
 * to the unreleased commits. Nothing is committed or tagged; the printed
 * commands do that after review.
 *
 * @example
 * bun run release:prepare 0.1.0
 */

import { runSequential, task } from './lib';
import { assertLockstep, readVersions, writeVersions } from './versions';

const version = process.argv[2];
if (!version) {
  console.error('Usage: bun run release:prepare <version>');
  process.exit(2);
}

await writeVersions(version);
const results = await runSequential([
  task('cargo update -w', ['cargo', 'update', '--workspace']),
  task('git-cliff', [
    'bunx',
    'git-cliff',
    '--config',
    'cliff.toml',
    '--tag',
    `v${version}`,
    '--output',
    'CHANGELOG.md',
  ]),
]);
if (results.some((result) => !result.ok)) process.exit(1);
assertLockstep(await readVersions(), version);

console.log(`
Prepared ${version}. Review the diff, then:

  git add -A && git commit -m "chore(release): v${version}"
  git tag -s v${version} -m "v${version}"
  git push origin main v${version}
`);
