/** `bun ./scripts/check-versions.ts [expected]`: every manifest carries the same version. */

import { assertLockstep, readVersions } from './versions';

const expected = process.argv[2];
const versions = await readVersions();
assertLockstep(versions, expected);
console.log(`versions in lockstep: ${versions[0]?.version}`);
