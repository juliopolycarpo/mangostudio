import { describe, expect, it } from 'bun:test';

import { makeCiDurations, makeCiJob, makeCiRun } from '../testing/metrics-fixture';
import { renderCiDurationSection } from './ci';

describe('renderCiDurationSection', () => {
  it('renders wall clock, critical path, slowest jobs, and both comparison deltas', () => {
    const rendered = renderCiDurationSection(
      makeCiDurations({
        head: makeCiRun(2, [
          makeCiJob('Test / Run tests', 280),
          makeCiJob('Build / Frontend', 80),
          makeCiJob('Lint / Static analysis', 40),
        ]),
      })
    );

    expect(rendered).toContain('| Wall clock (shared jobs) | 4m 0s | 4m 40s | 🔴 ▲ +40s |');
    expect(rendered).toContain(
      '| Critical path | `Test / Run tests` · 4m 0s | `Test / Run tests` · 4m 40s | 🔴 ▲ +40s |'
    );
    expect(rendered).toContain('**Since previous PR run:** 4m 20s → 4m 40s (🔴 ▲ +20s)');
    expect(rendered).toContain('#### Five slowest head jobs');
    expect(rendered).toContain('| `Build / Frontend` | 1m 0s | 1m 20s | 🔴 ▲ +20s |');
  });

  it('renders explicit placeholders when the baseline is unavailable', () => {
    const rendered = renderCiDurationSection(
      makeCiDurations({
        base: makeCiRun(null, [], 'no successful main CI run found'),
      })
    );

    expect(rendered).toContain('| Wall clock (shared jobs) | n/a | 4m 40s | n/a |');
    expect(rendered).toContain('Base CI durations unavailable');
    expect(rendered).toContain('no successful main CI run found');
    expect(rendered).not.toContain('NaN');
  });

  it('lists in-flight jobs instead of silently dropping them', () => {
    const rendered = renderCiDurationSection(
      makeCiDurations({
        head: makeCiRun(2, [
          makeCiJob('Test / Run tests', 280),
          makeCiJob('QA Metrics / Collect', null),
        ]),
      })
    );

    expect(rendered).toContain('Head jobs still in flight');
    expect(rendered).toContain('`QA Metrics / Collect` (`in_progress`)');
  });

  it('excludes main-only baseline stages from the head comparison', () => {
    const rendered = renderCiDurationSection(
      makeCiDurations({
        base: makeCiRun(1, [
          makeCiJob('Test / Run tests', 240),
          makeCiJob('Build / Frontend', 60),
          // Canary only ever runs on main pushes, long after the gate closes.
          makeCiJob('Canary / Publish npm', 300, { startOffsetSeconds: 240 }),
        ]),
      })
    );

    expect(rendered).toContain('| Wall clock (shared jobs) | 4m 0s | 4m 40s | 🔴 ▲ +40s |');
    expect(rendered).toContain('| Critical path | `Test / Run tests` · 4m 0s |');
    expect(rendered).not.toContain('Canary / Publish npm');
  });

  it('degrades a missing payload to a non-fatal placeholder', () => {
    const rendered = renderCiDurationSection(null, 'CI duration payload was not produced');

    expect(rendered).toContain('CI duration (unavailable)');
    expect(rendered).toContain('CI duration payload was not produced');
  });
});
