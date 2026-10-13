#!/usr/bin/env bun
// Dependency-free adapter for Protocol CI's canonical path predicate.
import { readChangedPaths } from '../lib/changed-paths';
import { touchesProtocolSurface } from '../lib/protocol';

if (import.meta.main) {
  try {
    const [command, file, ...extra] = process.argv.slice(2);
    if (command !== 'relevance' || extra.length > 0) {
      throw new Error('protocol-lanes: expected relevance <NUL path file>');
    }
    console.log(`protocol=${touchesProtocolSurface(readChangedPaths(file))}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
