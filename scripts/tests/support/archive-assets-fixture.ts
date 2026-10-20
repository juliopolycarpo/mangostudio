import { archiveReleaseAssets } from '../../release/archive-assets';
import { extractTargetArchive } from '../../release/extract-target';

const input = JSON.parse(process.argv[3] ?? '');
if (process.argv[2] === 'archive') await archiveReleaseAssets(input);
else if (process.argv[2] === 'extract') await extractTargetArchive(input);
else
  throw new Error(
    `expected archive fixture operation: archive | extract; received: ${process.argv[2]}`
  );
