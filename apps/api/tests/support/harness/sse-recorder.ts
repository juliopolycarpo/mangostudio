/** Bounded incremental SSE reader for route-level integration tests. */

const MAX_RECORDED_SSE_BYTES = 1024 * 1024;

export class SseRecorder {
  readonly events: Array<Record<string, unknown>> = [];
  private readonly reader: {
    read(): Promise<{ done: true; value?: never } | { done: false; value: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };
  private readonly decoder = new TextDecoder();
  private buffered = '';
  private recordedBytes = 0;
  private ended = false;

  constructor(response: Response) {
    if (!response.body) throw new Error('Expected an SSE response body.');
    this.reader = response.body.getReader();
  }

  async readUntil(
    predicate: (event: Record<string, unknown>) => boolean
  ): Promise<Record<string, unknown>> {
    const existing = this.events.find(predicate);
    if (existing) return existing;

    while (!this.ended) {
      await this.readNextChunk();
      const match = this.events.find(predicate);
      if (match) return match;
    }

    throw new Error(`SSE stream ended before the expected event. Seen: ${this.describeEvents()}`);
  }

  async finish(): Promise<Array<Record<string, unknown>>> {
    while (!this.ended) await this.readNextChunk();
    return this.events;
  }

  private async readNextChunk(): Promise<void> {
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      this.buffered += this.decoder.decode();
      this.consumeFrames();
      return;
    }

    this.recordedBytes += value.byteLength;
    if (this.recordedBytes > MAX_RECORDED_SSE_BYTES) {
      await this.reader.cancel('SSE fixture byte limit exceeded');
      throw new Error(`SSE fixture exceeded ${MAX_RECORDED_SSE_BYTES} bytes.`);
    }
    this.buffered += this.decoder.decode(value, { stream: true });
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (true) {
      const boundary = this.buffered.indexOf('\n\n');
      if (boundary < 0) return;
      const frame = this.buffered.slice(0, boundary);
      this.buffered = this.buffered.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      if (!data) continue;
      this.events.push(JSON.parse(data) as Record<string, unknown>);
    }
  }

  private describeEvents(): string {
    return this.events.map((event) => String(event.type ?? 'unknown')).join(', ');
  }
}
