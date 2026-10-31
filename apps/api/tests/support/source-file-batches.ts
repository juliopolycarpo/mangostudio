const READ_BATCH_SIZE = 8;

/**
 * Read every source path in ordered batches, draining a failed batch before rejecting.
 * @example const texts = await readSourceFileBatches(paths, (path) => Bun.file(path).text());
 */
export async function readSourceFileBatches(
  paths: readonly string[],
  read: (path: string) => Promise<string>
): Promise<string[]> {
  const texts: string[] = [];
  for (let offset = 0; offset < paths.length; offset += READ_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + READ_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (path) => read(path)));
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            new Error(
              `API source file ${JSON.stringify(batch[index])}: expected readable text | received: ${String(result.reason)}`,
              { cause: result.reason }
            ),
          ]
        : []
    );
    if (failures.length)
      throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
    texts.push(
      ...results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    );
  }
  return texts;
}
