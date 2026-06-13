#!/usr/bin/env bun
// Fill dry-run SHA256SUMS with placeholder rows for release targets not built locally.

import { readFileSync, writeFileSync } from 'node:fs';

import { fillDryRunChecksumManifest } from '../lib/dry-run-checksums';
import {
  assertNoUnexpectedArguments,
  error,
  type ParsedArgs,
  parseArgs,
  success,
} from '../lib/runner';

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/fill-dry-run-checksums.ts --version <version> --sums <SHA256SUMS>

Adds deterministic placeholder checksum rows for any binary release target that
is missing from a dry-run SHA256SUMS manifest.

Flags:
  --version <version>  Release version used in archive names
  --sums <path>        SHA256SUMS file to update in place
  --help               Show this help message`);
  process.exit(0);
};

function requireValue(args: ParsedArgs, flag: string): string {
  const value = args.values[flag];
  if (!value) {
    throw new Error(`Missing required ${flag}`);
  }
  return value;
}

function main(): void {
  const args = parseArgs({ valueFlags: ['--version', '--sums'] });
  if (args.flags['--help']) printHelp();
  assertNoUnexpectedArguments(args.positional);

  const version = requireValue(args, '--version');
  const sumsPath = requireValue(args, '--sums');
  const currentManifest = readFileSync(sumsPath, 'utf8');
  const filledManifest = fillDryRunChecksumManifest(currentManifest, version);
  writeFileSync(sumsPath, filledManifest);
  success(`Dry-run checksums updated: ${sumsPath}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
