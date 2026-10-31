import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Appends and syncs one record before returning, so an outer timeout cannot erase earlier samples. Example: appendBenchmarkJournal(path, { kind: 'started', index: 1 }). */
export async function appendBenchmarkJournal(
  path: string | undefined,
  record: unknown
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'a');
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Atomically replaces a progress receipt; an interrupted write leaves the prior checkpoint intact. Example: writeBenchmarkProgress(path, { complete: false, attempts }). */
export async function writeBenchmarkProgress(
  path: string | undefined,
  receipt: unknown
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.partial`;
  const file = await open(temporary, 'w');
  try {
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
