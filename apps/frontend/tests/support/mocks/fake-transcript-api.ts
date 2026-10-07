import type { Message } from '@mangostudio/shared/chat';

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
  private readonly rowsByChat = new Map<string, Message[]>();
  private readonly chatId: string;
  private readonly originalFetch = globalThis.fetch;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private holds: (url: URL) => boolean = () => true;
  private refusal: { status: number; matches: (url: URL) => boolean } | null = null;

  constructor(options: { chatId: string; total: number }) {
    this.chatId = options.chatId;
    this.alsoServe(options.chatId, options.total);
  }

  /** Serves another chat, `msg-001` to `msg-<total>`, from the same hub. */
  alsoServe(chatId: string, total: number): this {
    this.rowsByChat.set(
      chatId,
      Array.from({ length: total }, (_, index) => FakeTranscriptApi.messageAt(chatId, index + 1))
    );
    return this;
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

  /** Every request that was aborted by its caller while it was in flight, as `pathname + search`. */
  readonly aborted: string[] = [];

  /** Appends the next message, as another client or a finished turn would. */
  appendMessage(): Message {
    const rows = this.rowsByChat.get(this.chatId) ?? [];
    const message = FakeTranscriptApi.messageAt(this.chatId, rows.length + 1);
    this.rowsByChat.set(this.chatId, [...rows, message]);
    return message;
  }

  /**
   * Holds responses until {@link release}, so a test can observe an in-flight
   * request: every request, or only those `matches` accepts. A held request
   * ends early with an `AbortError` when its caller aborts it, like a real one.
   */
  hold(matches: (url: URL) => boolean = () => true): void {
    this.holds = matches;
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  /** Holds the older-page requests (those with a cursor) and lets the newest page through. */
  holdOlder(): void {
    this.hold((url) => url.searchParams.has('cursor'));
  }

  /** Answers older-page requests (those with a cursor) with an HTTP `status`, e.g. 429. */
  refuseOlder(status: number): void {
    this.refusal = { status, matches: (url) => url.searchParams.has('cursor') };
  }

  /** Stops refusing requests. */
  stopRefusing(): void {
    this.refusal = null;
  }

  /** Older-page requests received so far (those with a cursor). */
  get olderRequests(): string[] {
    return this.requests.filter((request) => request.includes('cursor='));
  }

  /** Lets the held responses through. */
  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  install(): this {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.respond(input, init)) as unknown as typeof fetch;
    return this;
  }

  restore(): void {
    this.release();
    globalThis.fetch = this.originalFetch;
  }

  private async respond(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost'
    );
    const chatId = /^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname)?.[1] ?? '';
    if (!this.rowsByChat.has(chatId)) {
      throw new Error(
        `[fake-transcript-api] expected path: /api/chats/<${[...this.rowsByChat.keys()].join('|')}>/messages | received: ${url.pathname}`
      );
    }
    const request = `${url.pathname}${url.search}`;
    this.requests.push(request);
    if (this.gate && this.holds(url)) await this.waitForRelease(request, init?.signal);
    if (this.refusal?.matches(url)) {
      return Response.json({ error: 'too many requests' }, { status: this.refusal.status });
    }
    return Response.json(this.page(chatId, url.searchParams));
  }

  private waitForRelease(request: string, signal: AbortSignal | null | undefined): Promise<void> {
    const released = this.gate ?? Promise.resolve();
    if (!signal) return released;
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.aborted.push(request);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      void released.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }

  private page(chatId: string, params: URLSearchParams) {
    const rows = this.rowsByChat.get(chatId) ?? [];
    const limit = Number(params.get('limit') ?? 50);
    const newestFirst = params.get('order') === 'desc';
    const cursor = params.get('cursor');
    const position = cursor === null ? null : Number(cursor);

    // Rows in the order the page is read, then the window cut from that end.
    const ordered = newestFirst ? [...rows].reverse() : rows;
    const rest =
      position === null
        ? ordered
        : ordered.filter((_, index) => {
            const rowPosition = newestFirst ? rows.length - index : index + 1;
            return newestFirst ? rowPosition < position : rowPosition > position;
          });
    const window = rest.slice(0, limit);
    const edge = window.at(-1);
    const hasMore = rest.length > limit;
    const edgePosition = edge ? rows.indexOf(edge) + 1 : null;

    return {
      messages: newestFirst ? [...window].reverse() : window,
      nextCursor: hasMore && edgePosition !== null ? String(edgePosition) : null,
      contextInfo: cursor === null ? null : undefined,
    };
  }
}
