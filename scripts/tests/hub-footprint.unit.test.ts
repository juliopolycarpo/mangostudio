import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import {
  parseCandidates,
  parseCheckpoints,
  parseProcessCpuMs,
  parseProcessStatus,
} from '../bench/hub-footprint';
import { referencedAssetPaths } from '../lib/hub-workload';

const STATUS = [
  'Name:\tmangostudio',
  'VmHWM:\t   69640 kB',
  'VmRSS:\t   70836 kB',
  'RssAnon:\t   18596 kB',
  'RssFile:\t    3312 kB',
  'RssShmem:\t   48976 kB',
  'Threads:\t14',
].join('\n');

describe('parseProcessStatus', () => {
  it('reads the five memory fields in kB', () => {
    expect(parseProcessStatus(STATUS)).toEqual({
      VmRSS: 70836,
      RssAnon: 18596,
      RssFile: 3312,
      RssShmem: 48976,
      VmHWM: 69640,
    });
  });

  it('names the missing field instead of returning NaN', () => {
    const withoutShmem = STATUS.replace(/RssShmem:.*\n/, '');
    expect(() => parseProcessStatus(withoutShmem)).toThrow(/expected a "RssShmem: <n> kB" line/);
  });
});

describe('parseProcessCpuMs', () => {
  // Fields 14 and 15 (utime 31, stime 7) are 38 ticks of 10 ms each.
  const STAT = '4242 (mangostudio) S 1 4242 4242 0 -1 4194560 1 0 0 0 31 7 0 0 20 0 14 0 99';

  it('adds user and system ticks and converts them to milliseconds', () => {
    expect(parseProcessCpuMs(STAT)).toBe(380);
  });

  it('counts fields from the last parenthesis when the command name holds spaces and parentheses', () => {
    expect(parseProcessCpuMs(STAT.replace('(mangostudio)', '(my (odd) name)'))).toBe(380);
  });

  it('names the stat line when utime and stime are missing', () => {
    expect(() => parseProcessCpuMs('4242 (mangostudio) S 1')).toThrow(
      /expected integer utime and stime in fields 14 and 15 \| received: 4242 \(mangostudio\) S 1/
    );
  });
});

describe('parseCandidates', () => {
  it('splits label=path and resolves the path', () => {
    expect(parseCandidates(['base=./a/mangostudio', 'head=/tmp/b=c'])).toEqual([
      { label: 'base', binary: resolve('./a/mangostudio') },
      // An absolute path stays itself, but Windows adds the current drive to a rooted one.
      { label: 'head', binary: resolve('/tmp/b=c') },
    ]);
  });

  it('refuses a candidate without a label, a path, or a unique label', () => {
    expect(() => parseCandidates(['./a'])).toThrow(
      'candidate: expected label=path | received: ./a'
    );
    expect(() => parseCandidates(['a='])).toThrow('candidate: expected label=path | received: a=');
    expect(() => parseCandidates(['a=./x', 'a=./y'])).toThrow(
      'candidate: expected unique labels | received: a twice'
    );
  });
});

describe('parseCheckpoints', () => {
  it('reads ascending request counts', () => {
    expect(parseCheckpoints('1, 10,100')).toEqual([1, 10, 100]);
  });

  it.each(['', '0', '10,1', '5,5', '1,x', '1.5'])('rejects %p', (value) => {
    expect(() => parseCheckpoints(value)).toThrow(
      `--identity-checkpoints: expected ascending positive integers | received: ${value}`
    );
  });
});

describe('referencedAssetPaths', () => {
  it('lists hashed scripts and stylesheets once, in page order', () => {
    const html =
      '<link rel="stylesheet" href="/assets/main-1.css"><script type="module" src="/assets/main-2.js"></script>' +
      '<link rel="modulepreload" href="/assets/main-2.js"><link rel="icon" href="/favicon.ico">';
    expect(referencedAssetPaths(html)).toEqual(['/assets/main-1.css', '/assets/main-2.js']);
  });

  it('returns nothing for a page without hashed assets', () => {
    expect(referencedAssetPaths('<html></html>')).toEqual([]);
  });
});
