import type { Message } from '@mangostudio/shared';

/**
 * A fake hub for `GET /api/chats/:id/messages` that pages like the real one.
 *
 * It holds `total` messages, `msg-001` (oldest) to `msg-<total>` (newest), and
 * answers the route's whole paging contract: `limit`, an opaque `cursor`
 * (`<position>`), and `order` (`asc` by default, `desc` from the newest end).
 * Every page is chronological inside itself; `nextCursor` is the position of
 * the edge facing the rows not read yet, `null` on the last page.
 *
 * Use it where a test needs the paging behaviour rather than a canned page:
 *
 * @example
 * const api = new FakeTranscriptApi({ chatId: 'chat-1', total: 120 }).install();
 * try {
 *   // ... render, scroll ...
 *   expect(api.requests).toHaveLength(2);
 * } finally {
 *   api.restore();
 * }
 */
export class FakeTranscriptApi {
  /** Every transcript request received, as `pathname + search`, oldest first. */
  readonly requests: string[] = [];
  private rows: Message[];
  private readonly chatId: string;
  private readonly originalFetch = globalThis.fetch;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  constructor(options: { chatId: string; total: number }) {
    this.chatId = options.chatId;
    this.rows = Array.from({ length: options.total }, (_, index) =>
      FakeTranscriptApi.messageAt(options.chatId, index + 1)
    );
  }

  /** The message the fake stores at a 1-based chronological position. */
  static messageAt(chatId: string, position: number): Message {
    const label = String(position).padStart(3, '0');
    return {
      id: `m-${label}`,
      chatId,
      role: position % 2 === 1 ? 'user' : 'ai',
      text: `msg-${label}`,
      timestamp: 1_700_000_000_000 + position,
      isGenerating: false,
      interactionMode: 'chat',
    };
  }

  /** Appends the next message, as another client or a finished turn would. */
  appendMessage(): Message {
    const message = FakeTranscriptApi.messageAt(this.chatId, this.rows.length + 1);
    this.rows = [...this.rows, message];
    return message;
  }

  /** Holds every response until {@link release}, so a test can observe an in-flight request. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  /** Lets the held responses through. */
  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  install(): this {
    globalThis.fetch = ((input: RequestInfo | URL) =>
      this.respond(input)) as unknown as typeof fetch;
    return this;
  }

  restore(): void {
    this.release();
    globalThis.fetch = this.originalFetch;
  }

  private async respond(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost'
    );
    if (url.pathname !== `/api/chats/${this.chatId}/messages`) {
      throw new Error(
        `[fake-transcript-api] expected path: /api/chats/${this.chatId}/messages | received: ${url.pathname}`
      );
    }
    this.requests.push(`${url.pathname}${url.search}`);
    if (this.gate) await this.gate;
    return Response.json(this.page(url.searchParams));
  }

  private page(params: URLSearchParams) {
    const limit = Number(params.get('limit') ?? 50);
    const newestFirst = params.get('order') === 'desc';
    const cursor = params.get('cursor');
    const position = cursor === null ? null : Number(cursor);

    // Rows in the order the page is read, then the window cut from that end.
    const ordered = newestFirst ? [...this.rows].reverse() : this.rows;
    const rest =
      position === null
        ? ordered
        : ordered.filter((_, index) => {
            const rowPosition = newestFirst ? this.rows.length - index : index + 1;
            return newestFirst ? rowPosition < position : rowPosition > position;
          });
    const window = rest.slice(0, limit);
    const edge = window.at(-1);
    const hasMore = rest.length > limit;
    const edgePosition = edge ? this.rows.indexOf(edge) + 1 : null;

    return {
      messages: newestFirst ? [...window].reverse() : window,
      nextCursor: hasMore && edgePosition !== null ? String(edgePosition) : null,
      contextInfo: cursor === null ? null : undefined,
    };
  }
}
