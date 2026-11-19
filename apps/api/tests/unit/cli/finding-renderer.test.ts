import { describe, expect, it } from 'bun:test';

import type { RuntimeFindingCode } from '@mangostudio/shared/environments';
import { environmentFindingTemplatesEn } from '@mangostudio/shared/environments';

import { fail, ok } from '../../../src/cli/doctor-checks';
import {
  checkResultToFinding,
  findingParams,
  findingSeverity,
  hasUnfilledPlaceholders,
  renderFinding,
  RUNTIME_FINDING_CODES,
  runtimeHealthToCheckStatus,
} from '../../../src/cli/finding-renderer';

function placeholdersFromTemplate(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
}

function sampleParamsForCode(code: RuntimeFindingCode): Record<string, string> {
  const template = environmentFindingTemplatesEn[code];
  const params: Record<string, string> = {};
  for (const key of placeholdersFromTemplate(template)) {
    if (key === 'runtime') params[key] = 'node';
    else if (key === 'targetId') params[key] = 'claude';
    else if (key === 'manager') params[key] = 'nvm';
    else if (key === 'ltsStatus') params[key] = 'lts-superseded';
    else if (key.endsWith('PathIndex')) params[key] = '0';
    else if (key === 'versions') params[key] = '18, 20';
    else if (key === 'version') params[key] = '20.11.0';
    else if (key === 'minimumVersion') params[key] = '18.0.0';
    else if (key === 'locationId') params[key] = 'cursor-skills';
    else if (key === 'configHome') params[key] = '/home/user/.claude';
    else params[key] = `/tmp/${key}`;
  }
  return params;
}

describe('renderFinding', () => {
  it('renders shadowed-by-earlier-path with one-based PATH indices', () => {
    const line = renderFinding({
      code: 'shadowed-by-earlier-path',
      params: {
        effectivePath: '/home/dev/.nvm/versions/node/v22.13.0/bin/node',
        effectivePathIndex: '1',
        shadowedPath: '/usr/local/bin/node',
        shadowedPathIndex: '0',
      },
    });

    expect(line).toContain('PATH #1');
    expect(line).toContain('PATH #2');
    expect(hasUnfilledPlaceholders(line)).toBe(false);
  });

  it('has a template for every RuntimeFindingCode', () => {
    expect(RUNTIME_FINDING_CODES.length).toBeGreaterThan(0);
    for (const code of RUNTIME_FINDING_CODES) {
      expect(environmentFindingTemplatesEn[code]).toBeTruthy();
    }
  });

  it('interpolates every placeholder for every finding code', () => {
    for (const code of RUNTIME_FINDING_CODES) {
      const params = sampleParamsForCode(code);
      const line = renderFinding({ code, params });
      expect(hasUnfilledPlaceholders(line)).toBe(false);
    }
  });
});

describe('findingParams', () => {
  it('names identifiers, counts PATH positions from one, and keeps an LTS status a code', () => {
    expect(
      findingParams({
        code: 'shadowed-by-earlier-path',
        params: {
          runtime: 'node',
          shadowedPath: '/a/node',
          shadowedPathIndex: '0',
          effectivePath: '/b/node',
          effectivePathIndex: '3',
          ltsStatus: 'end-of-life',
        },
      })
    ).toEqual({
      runtime: 'Node.js',
      shadowedPath: '/a/node',
      shadowedPathIndex: '1',
      effectivePath: '/b/node',
      effectivePathIndex: '4',
      ltsStatus: 'end-of-life',
    });
  });

  it("lets a version manager's `manager` stand in for the `{runtime}` of a shared template", () => {
    expect(findingParams({ code: 'not-found', params: { manager: 'fnm' } })).toEqual({
      manager: 'fnm',
      runtime: 'fnm',
    });
  });

  it('renders an LTS status as its English label, and leaves an unknown one unfilled', () => {
    expect(
      renderFinding({
        code: 'outdated-lts',
        params: { version: '20.1.0', ltsStatus: 'end-of-life' },
      })
    ).toBe('Version 20.1.0 is end of life and will stop receiving fixes.');
    expect(
      renderFinding({
        code: 'outdated-lts',
        params: { version: '20.1.0', ltsStatus: 'new-status' },
      })
    ).toBe('Version 20.1.0 is {ltsStatus} and will stop receiving fixes.');
  });
});

describe('checkResultToFinding', () => {
  it('round-trips legacy detail into a renderable finding', () => {
    const check = ok('Config', 'loaded from /data/config.toml');
    const finding = checkResultToFinding(check);
    expect(renderFinding(finding)).toBe(check.detail);
  });

  it('preserves failure detail verbatim', () => {
    const check = fail('Database', 'file missing');
    expect(renderFinding(checkResultToFinding(check))).toBe('file missing');
  });
});

describe('findingSeverity', () => {
  it('treats cli-not-installed as fail', () => {
    expect(findingSeverity({ code: 'cli-not-installed', params: { targetId: 'codex' } })).toBe(
      'fail'
    );
  });

  it('treats multiple-versions as warn', () => {
    expect(
      findingSeverity({
        code: 'multiple-versions',
        params: { runtime: 'node', versions: '18, 20' },
      })
    ).toBe('warn');
  });
});

describe('runtimeHealthToCheckStatus', () => {
  it('maps missing health to fail', () => {
    expect(runtimeHealthToCheckStatus('missing')).toBe('fail');
  });
});
