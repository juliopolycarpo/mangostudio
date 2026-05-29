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

const loadMetrics = async (path: string): Promise<Metrics | null> => {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as Metrics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[render] failed to load ${path}: ${message}\n`);
    return null;
  }
};

const [baseMetrics, headMetrics] = await Promise.all([loadMetrics(baseArg), loadMetrics(headArg)]);
process.stdout.write(`${renderDocument(baseMetrics, headMetrics)}\n`);
