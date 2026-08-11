/**
 * Comparing two captures, and deciding which differences are worth failing on.
 *
 * The distinction this module exists for: a vendor **adding** something and a
 * vendor **taking something away** are not the same event, and treating them
 * the same is what makes a drift check get ignored. Every one of these CLIs
 * ships constantly, and almost all of that motion is additive — a new model, a
 * new flag, a new capability key. A check that failed on all of it would be red
 * most weeks and would teach maintainers to rerun it rather than read it.
 *
 * So:
 *
 * - **added** — a key, or an element shape, that was not in the committed
 *   capture. Reported, never fatal. The adapters ignore what they do not know
 *   by construction, so this cannot break a turn.
 * - **removed** — something the committed capture had and the live binary no
 *   longer produces. Fatal. This is the case where an adapter is reading a
 *   field that is gone.
 * - **changed** — a leaf whose type or preserved value differs. Fatal, for the
 *   same reason: `protocolVersion` moving from 1 to 2, or a string becoming an
 *   object, is a contract the adapters were not written against.
 *
 * Arrays are compared element-wise *after* `normalizeCapture` has sorted and
 * deduplicated them, so an appended element shape reads as one `added` rather
 * than as every following element having changed. A removal in the middle of a
 * long array will still misattribute which element moved — the verdict stays
 * correct (fatal), only the path is approximate.
 */

type ContractChangeKind = 'added' | 'removed' | 'changed';

export interface ContractChange {
  readonly kind: ContractChangeKind;
  /** Dotted path into the capture, e.g. `agentCapabilities.promptCapabilities.image`. */
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalarArray(values: readonly unknown[]): boolean {
  return values.every((entry) => entry === null || typeof entry !== 'object');
}

function join(path: string, segment: string): string {
  return path.length === 0 ? segment : `${path}${segment.startsWith('[') ? '' : '.'}${segment}`;
}

function compare(
  committed: unknown,
  regenerated: unknown,
  path: string,
  changes: ContractChange[]
): void {
  if (isPlainObject(committed) && isPlainObject(regenerated)) {
    for (const key of new Set([...Object.keys(committed), ...Object.keys(regenerated)])) {
      const left = committed[key];
      const right = regenerated[key];
      if (!(key in committed)) {
        changes.push({ kind: 'added', path: join(path, key), after: describe(right) });
      } else if (!(key in regenerated)) {
        changes.push({ kind: 'removed', path: join(path, key), before: describe(left) });
      } else {
        compare(left, right, join(path, key), changes);
      }
    }
    return;
  }

  if (Array.isArray(committed) && Array.isArray(regenerated)) {
    // A list of scalars is a *set*, and comparing it position by position would
    // be actively misleading: a sorted flag list that gains one entry in the
    // middle would report every entry after it as changed, turning one additive
    // release into a wall of fatal findings. Object arrays keep positional
    // pairing, because there the fields are what is being compared.
    if (isScalarArray(committed) && isScalarArray(regenerated)) {
      const before = new Set(committed.map((entry) => describe(entry)));
      const after = new Set(regenerated.map((entry) => describe(entry)));
      for (const entry of after) {
        if (!before.has(entry))
          changes.push({ kind: 'added', path: join(path, '[]'), after: entry });
      }
      for (const entry of before) {
        if (!after.has(entry)) {
          changes.push({ kind: 'removed', path: join(path, '[]'), before: entry });
        }
      }
      return;
    }

    const shared = Math.min(committed.length, regenerated.length);
    for (let index = 0; index < shared; index += 1) {
      compare(committed[index], regenerated[index], join(path, `[${index}]`), changes);
    }
    for (let index = shared; index < regenerated.length; index += 1) {
      changes.push({
        kind: 'added',
        path: join(path, `[${index}]`),
        after: describe(regenerated[index]),
      });
    }
    for (let index = shared; index < committed.length; index += 1) {
      changes.push({
        kind: 'removed',
        path: join(path, `[${index}]`),
        before: describe(committed[index]),
      });
    }
    return;
  }

  if (JSON.stringify(committed) === JSON.stringify(regenerated)) return;
  changes.push({
    kind: 'changed',
    path: path.length === 0 ? '<root>' : path,
    before: describe(committed),
    after: describe(regenerated),
  });
}

/** Every difference between a committed capture and a freshly taken one. */
export function diffCaptures(committed: unknown, regenerated: unknown): ContractChange[] {
  const changes: ContractChange[] = [];
  compare(committed, regenerated, '', changes);
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/** True when this change means an adapter is reading something that is gone. */
export function isBreaking(change: ContractChange): boolean {
  return change.kind !== 'added';
}

/** One change as a line a maintainer can read in a CI log. */
export function formatChange(change: ContractChange): string {
  const label = change.kind.padEnd(8);
  if (change.kind === 'changed')
    return `  ${label}${change.path}: ${change.before} → ${change.after}`;
  const value = change.kind === 'added' ? change.after : change.before;
  return `  ${label}${change.path}${value === undefined ? '' : `: ${value}`}`;
}
