import { type PushDistRepoOptions, pushDistRepo } from '../../release/push-dist-repo';

const options = JSON.parse(process.argv[2] ?? '') as PushDistRepoOptions;
console.log(await pushDistRepo(options));
