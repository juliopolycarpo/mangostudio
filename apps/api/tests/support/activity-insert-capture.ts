/** Captures the real recorder's bulk writes. @example const capture = new ActivityInsertCapture(); */
export class ActivityInsertCapture {
  readonly rows: Array<Record<string, unknown>> = [];

  /** Accept only activity batches; other tables remain available to the fixture. @example capture.onInsert('activity_events', rows); */
  readonly onInsert = (table: string, values: unknown): void => {
    if (table !== 'activity_events') return;
    if (!Array.isArray(values)) {
      throw new Error(
        `activity insert capture: expected an array of rows | received: ${values === null ? 'null' : typeof values}`
      );
    }
    this.rows.push(...(values as Array<Record<string, unknown>>));
  };
}
