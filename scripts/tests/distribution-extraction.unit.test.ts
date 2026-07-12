import { describe, expect, test } from 'bun:test';

import { distributionTarArgs } from '../release/extract-distribution';

describe('distribution extraction', () => {
  test('forces local Windows drive paths and leaves POSIX tar arguments unchanged', () => {
    expect(distributionTarArgs('list', 'D:\\tmp\\bundle.tar.gz', undefined, 'win32')).toEqual([
      '--force-local',
      '-tzf',
      'D:\\tmp\\bundle.tar.gz',
    ]);
    expect(distributionTarArgs('extract', '/tmp/bundle.tar.gz', '/workspace', 'linux')).toEqual([
      '-xzf',
      '/tmp/bundle.tar.gz',
      '-C',
      '/workspace',
    ]);
  });
});
