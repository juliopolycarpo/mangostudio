// QA-gate comment renderer entrypoint. Loads the base and head metrics JSON
// and writes the sticky PR comment markdown to stdout.
// Section renderers live in ./render/*.

import type { Metrics } from './collect/types';
import { renderDocument } from './render/document';

const [, , baseArg, headArg] = process.argv;
if (!baseArg || !headArg) {
  process.stderr.write('Usage: bun ./scripts/qa-gate/render.ts <base.json> <head.json>\n');
  process.exit(1);
}

// The workflow writes `{}` when a side's metrics artifact is missing (its
// collector job failed). That parses fine but lacks every metric record, so
// require the core fields before trusting it — otherwise treat the side as
// absent and let the renderer's null path render n/a columns plus a note.
const REQUIRED_METRIC_FIELDS = ['coverage', 'loc', 'tsErrors', 'tests'] as const;

const hasMetricShape = (value: unknown): value is Metrics =>
  typeof value === 'object' &&
  value !== null &&
  REQUIRED_METRIC_FIELDS.every((field) => field in value);

const loadMetrics = async (path: string): Promise<Metrics | null> => {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (!hasMetricShape(parsed)) {
      process.stderr.write(`[render] ${path} lacks metric fields; treating side as absent\n`);
      return null;
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[render] failed to load ${path}: ${message}\n`);
    return null;
  }
};

const [baseMetrics, headMetrics] = await Promise.all([loadMetrics(baseArg), loadMetrics(headArg)]);
process.stdout.write(`${renderDocument(baseMetrics, headMetrics)}\n`);
