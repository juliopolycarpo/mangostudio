import { describe, expect, it } from 'bun:test';
import {
  latestVersionsFromIndex,
  renderNodeReleaseSchedule,
  scheduleLinesFromUpstream,
} from '../update-node-release-schedule';

describe('update-node-release-schedule', () => {
  it('combines lifecycle dates with the latest patch for each release line', () => {
    const latestByMajor = latestVersionsFromIndex([
      { version: 'v24.17.0' },
      { version: 'v24.18.0' },
      { version: 'v25.9.0' },
    ]);
    const lines = scheduleLinesFromUpstream(
      {
        v24: {
          start: '2025-05-06',
          lts: '2025-10-28',
          maintenance: '2026-10-20',
          end: '2028-04-30',
          codename: 'Krypton',
        },
        v25: {
          start: '2025-10-15',
          maintenance: '2026-04-01',
          end: '2026-06-01',
        },
      },
      latestByMajor
    );

    expect(lines).toEqual([
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
    ]);
  });

  it('renders a typed generated module', () => {
    const source = renderNodeReleaseSchedule('2026-07-26', [
      {
        major: 24,
        start: '2025-05-06',
        lts: '2025-10-28',
        maintenance: '2026-10-20',
        end: '2028-04-30',
        codename: 'krypton',
        latest: '24.18.0',
      },
    ]);

    expect(source).toContain("generatedAt: '2026-07-26'");
    expect(source).toContain("codename: 'krypton'");
    expect(source).toContain('as const satisfies NodeReleaseSchedule');
  });

  // `maintenance` is optional on purpose: a newly announced line that upstream
  // has not dated yet must not abort the refresh, so it must not render either.
  it('omits an undated maintenance line rather than emitting undefined', () => {
    const source = renderNodeReleaseSchedule('2026-07-26', [
      { major: 26, start: '2026-04-21', end: '2029-04-30' },
    ]);

    expect(source).not.toContain('maintenance');
    expect(source).not.toContain('undefined');
  });

  it('rejects malformed upstream lifecycle dates', () => {
    expect(() =>
      scheduleLinesFromUpstream(
        {
          v24: {
            start: 'soon',
            maintenance: '2026-10-20',
            end: '2028-04-30',
          },
        },
        new Map()
      )
    ).toThrow('Node 24 has an invalid start date.');
  });
});
