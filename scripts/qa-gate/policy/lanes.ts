// Policy over per-lane test results: which lanes are missing, which carry a
// real failure, and which recovered from one. Pure functions of a Metrics
// document; the verdict combines them and the renderers only format.

import type { Metrics } from '../collect/types';
import { presentValue } from '../model/states';
import { laneRows } from '../render/access';
import { formatNumber, inlineCode } from '../render/format';

/**
 * Lanes the lane registry says a component owns that the document lacks or
 * marks `unsupported`. Lanes that are present but partial, stale or unavailable
 * are reported by the collector-error path (`componentMeasurements`), so this
 * covers only evidence that is absent altogether.
 * // Usage: missingLanes(head) // ['lanes/apps/api/api-unit']
 */
export const missingLanes = (head: Metrics): string[] =>
  laneRows(head)
    .filter((row) => row.cell === null || row.cell.state === 'unsupported')
    .map((row) => `lanes/${row.component.root}/${row.laneId}`);

const plural = (count: number, singular: string): string =>
  `${formatNumber(count)} ${singular}${count === 1 ? '' : 's'}`;

/**
 * One attention item naming every lane with a failed test or a watchdog kill,
 * or null when none has. Counts of a partial lane are a lower bound but real.
 * // Usage: laneFailureItem(head) // 'test lanes failing: `api-unit` 2 failed tests'
 */
export const laneFailureItem = (head: Metrics): string | null => {
  const parts: string[] = [];
  for (const row of laneRows(head)) {
    const lane = presentValue(row.cell);
    if (!lane) continue;
    const bits: string[] = [];
    if (lane.failed > 0) bits.push(plural(lane.failed, 'failed test'));
    if (lane.timedOut > 0) bits.push(`timed out in ${plural(lane.timedOut, 'shard')}`);
    if (bits.length > 0) parts.push(`${inlineCode(row.laneId)} ${bits.join(', ')}`);
  }
  return parts.length > 0 ? `test lanes failing: ${parts.join('; ')}` : null;
};

/**
 * Non-blocking note for tests that failed in one run and passed in a later
 * one. The earlier failure is real information even though it does not fail
 * the verdict on its own.
 * // Usage: recoveredFailuresNote(head) // 'recovered failures: `api-unit` 1 test failed before passing'
 */
export const recoveredFailuresNote = (head: Metrics): string | null => {
  const parts: string[] = [];
  for (const row of laneRows(head)) {
    const lane = presentValue(row.cell);
    if (lane && lane.recovered > 0) {
      parts.push(
        `${inlineCode(row.laneId)} ${plural(lane.recovered, 'test')} failed before passing`
      );
    }
  }
  return parts.length > 0 ? `recovered failures: ${parts.join('; ')}` : null;
};
