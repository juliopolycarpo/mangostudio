/**
 * Counts the text a synchronous function searches and joins, so a test can bound
 * the work of a line reader without timing it: a reader that searches the whole
 * pending line on every read does work quadratic in the line, however fast the
 * machine is.
 *
 * Each `indexOf` and `lastIndexOf` call counts the units from its start index to
 * the end of the string it searched (an upper bound on what it can scan), and
 * each `join` counts the length of its result. The patches are restored before
 * this returns, so `run` must be synchronous.
 *
 * @example
 * const units = countScanWork(() => splitter.push('one\ntwo'));
 */
export function countScanWork(run: () => void): number {
  const { indexOf, lastIndexOf } = String.prototype;
  const { join } = Array.prototype;
  let units = 0;
  String.prototype.indexOf = function (this: string, search: string, from?: number): number {
    units += Math.max(0, this.length - (from ?? 0));
    return indexOf.call(this, search, from);
  };
  String.prototype.lastIndexOf = function (this: string, search: string, from?: number): number {
    units += this.length;
    return lastIndexOf.call(this, search, from);
  };
  Array.prototype.join = function (this: unknown[], separator?: string): string {
    const joined = join.call(this, separator);
    units += joined.length;
    return joined;
  };
  try {
    run();
  } finally {
    String.prototype.indexOf = indexOf;
    String.prototype.lastIndexOf = lastIndexOf;
    Array.prototype.join = join;
  }
  return units;
}
