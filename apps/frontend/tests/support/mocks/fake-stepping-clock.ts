/**
 * A monotonic clock that moves `stepMs` on every read, for `setTimeStopClock`. The slice loop
 * of `highlightCode` reads it once to set its deadline and once after each batch of lines, so the
 * step decides how many batches fit a time budget and a test needs no real time.
 *
 * @example
 * setTimeStopClock(new SteppingClock(10).now); // a 25 ms budget fits three batches
 */
export class SteppingClock {
  private at = 0;

  constructor(private readonly stepMs: number) {}

  now = (): number => {
    const reading = this.at;
    this.at += this.stepMs;
    return reading;
  };
}
