import { describe, expect, it } from 'bun:test';
import { classifyNodeLtsStatus, type NodeReleaseSchedule } from '@mangostudio/shared/environments';

const SCHEDULE: NodeReleaseSchedule = {
  generatedAt: '2026-07-01',
  lines: [
    {
      major: 22,
      start: '2024-04-24',
      lts: '2024-10-29',
      maintenance: '2025-10-21',
      end: '2027-04-30',
      codename: 'jod',
      latest: '22.23.1',
    },
    {
      major: 23,
      start: '2024-10-16',
      maintenance: '2025-04-01',
      end: '2025-06-01',
      latest: '23.11.1',
    },
    {
      major: 24,
      start: '2025-05-06',
      lts: '2025-10-28',
      maintenance: '2026-10-20',
      end: '2028-04-30',
      codename: 'krypton',
      latest: '24.18.0',
    },
    {
      major: 25,
      start: '2025-10-15',
      maintenance: '2026-04-01',
      end: '2026-06-01',
      latest: '25.9.0',
    },
    {
      major: 26,
      start: '2026-05-05',
      lts: '2026-10-28',
      maintenance: '2027-10-20',
      end: '2029-04-30',
      latest: '26.5.0',
    },
  ],
};

const TODAY = new Date('2026-07-26T12:00:00.000Z');

describe('classifyNodeLtsStatus', () => {
  it('classifies the newest LTS at its latest patch', () => {
    expect(classifyNodeLtsStatus('24.18.0', SCHEDULE, { now: TODAY })).toBe('current-lts');
  });

  it('flags an older patch on the newest LTS line', () => {
    expect(classifyNodeLtsStatus('24.17.0', SCHEDULE, { now: TODAY })).toBe('lts-outdated-patch');
  });

  it('flags a previous LTS that is still maintained', () => {
    expect(classifyNodeLtsStatus('22.23.1', SCHEDULE, { now: TODAY })).toBe('lts-superseded');
  });

  it('marks a release past its end date as end of life', () => {
    expect(classifyNodeLtsStatus('23.11.1', SCHEDULE, { now: TODAY })).toBe('end-of-life');
  });

  it('labels the active non-LTS line as a current release', () => {
    expect(classifyNodeLtsStatus('26.5.0', SCHEDULE, { now: TODAY })).toBe('current-release');
  });

  it('downgrades every status when bundled data is stale and no live data exists', () => {
    const stale = { ...SCHEDULE, generatedAt: '2025-01-01' };

    expect(classifyNodeLtsStatus('24.18.0', stale, { now: TODAY })).toBe('unknown');
    expect(classifyNodeLtsStatus('23.11.1', stale, { now: TODAY })).toBe('unknown');
    expect(classifyNodeLtsStatus('26.5.0', stale, { now: TODAY })).toBe('unknown');
  });

  it('uses live patch metadata when a refresh is available', () => {
    const stale = { ...SCHEDULE, generatedAt: '2025-01-01' };
    const latestByMajor = new Map([[24, '24.19.0']]);

    expect(
      classifyNodeLtsStatus('24.18.0', stale, {
        now: TODAY,
        liveDataAvailable: true,
        latestByMajor,
      })
    ).toBe('lts-outdated-patch');
  });

  it('reports majors older than the trimmed schedule as end of life', () => {
    const trimmed: NodeReleaseSchedule = {
      ...SCHEDULE,
      lines: [
        {
          major: 16,
          start: '2021-04-20',
          lts: '2021-10-26',
          maintenance: '2022-10-18',
          end: '2023-09-11',
          codename: 'gallium',
          latest: '16.20.2',
        },
        ...SCHEDULE.lines,
      ],
    };

    expect(classifyNodeLtsStatus('14.21.3', trimmed, { now: TODAY })).toBe('end-of-life');
  });

  it('stays unknown below an oldest tracked line that is still supported', () => {
    expect(classifyNodeLtsStatus('14.21.3', SCHEDULE, { now: TODAY })).toBe('unknown');
  });

  it('stays unknown for majors newer than the trimmed schedule', () => {
    expect(classifyNodeLtsStatus('28.0.0', SCHEDULE, { now: TODAY })).toBe('unknown');
  });

  it('does not let an older nvm alias cache override bundled patch data', () => {
    expect(
      classifyNodeLtsStatus('24.17.0', SCHEDULE, {
        now: TODAY,
        latestByMajor: new Map([[24, '24.17.0']]),
      })
    ).toBe('lts-outdated-patch');
  });
});
