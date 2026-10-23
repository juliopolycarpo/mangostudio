type GeminiHttpRoute = 'models' | 'interactions' | 'generate' | 'stream';

/** Synthetic SDK peer. Example: new FakeGeminiHttp('error') returns a provider API failure. */
export class FakeGeminiHttp {
  readonly requests: Array<{
    url: string;
    method: string;
    body: unknown;
    apiKey: string | null;
  }> = [];
  readonly started = Promise.withResolvers<void>();
  invocations = 0;
  signal: AbortSignal | undefined;

  constructor(private readonly behavior: 'normal' | 'error' | 'stall' | 'image' = 'normal') {}

  /** Implements the SDK's fetch option. Example: httpOptions: { fetch: peer.fetch }. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.invocations += 1;
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    request.signal.throwIfAborted();
    const route = this.route(request);
    const body = await request.clone().text();
    request.signal.throwIfAborted();
    this.signal = request.signal;
    this.requests.push({
      url: request.url,
      method: request.method,
      body: body ? JSON.parse(body) : null,
      apiKey: request.headers.get('x-goog-api-key'),
    });
    this.started.resolve();
    if (this.behavior === 'stall') return this.waitForAbort(request.signal);
    if (this.behavior === 'error') {
      return Response.json(
        { error: { code: 400, message: 'invalid synthetic model', status: 'INVALID_ARGUMENT' } },
        { status: 400 }
      );
    }
    return this.respond(route);
  };

  private route(request: Request): GeminiHttpRoute {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/v1beta/models') return 'models';
    if (request.method === 'POST' && pathname === '/v1beta/interactions') return 'interactions';
    const modelPath =
      /^\/v1beta\/models\/(gemini-test(?:-image)?|invalid):(generateContent|streamGenerateContent)$/;
    const match = modelPath.exec(pathname);
    if (request.method === 'POST' && match)
      return match[2] === 'generateContent' ? 'generate' : 'stream';
    throw new Error(
      `Gemini HTTP peer: expected GET /v1beta/models or POST to a supported model/Interactions endpoint | received: ${request.method} ${pathname}`
    );
  }

  private waitForAbort(signal: AbortSignal): Promise<Response> {
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  private respond(route: GeminiHttpRoute): Response {
    if (route === 'models') {
      return Response.json({
        models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }],
      });
    }
    if (route === 'interactions') {
      const events = [
        {
          event_type: 'interaction.created',
          interaction: { id: 'int_http', status: 'in_progress' },
        },
        {
          event_type: 'interaction.completed',
          interaction: { id: 'int_http', status: 'completed' },
        },
      ];
      return new Response(
        events
          .map((event) => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
    const part =
      this.behavior === 'image'
        ? { inlineData: { data: 'aGk=', mimeType: 'image/png' } }
        : { text: 'Synthetic response' };
    const payload = {
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
    };
    if (route === 'stream') {
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json(payload);
  }
}
