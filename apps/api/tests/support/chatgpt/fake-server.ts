import { makeAccessToken, makeIdToken, TEST_ACCOUNT_ID, TEST_EMAIL } from './index';

type TokenGrantType = 'authorization_code' | 'refresh_token';
type TokenFailure = 'server-error' | 'invalid-grant' | 'slow-response';

export interface RecordedChatGptTokenRequest {
  readonly grantType: string;
  readonly code: string | null;
  readonly refreshToken: string | null;
}

export interface RecordedChatGptAuthorizeRequest {
  readonly state: string | null;
  readonly redirectUri: string | null;
  readonly codeChallenge: string | null;
}

export interface RecordedChatGptBackendRequest {
  readonly path: string;
  readonly headers: Record<string, string | null>;
  readonly body: Record<string, unknown>;
}

export type FakeChatGptResponsesScript =
  | { type: 'events'; events: Array<Record<string, unknown>>; headers?: Record<string, string> }
  | { type: 'status'; status: number; body?: unknown }
  | { type: 'malformed'; events?: Array<Record<string, unknown>>; raw?: string };

export interface FakeChatGptServerOptions {
  readonly accountId?: string;
  readonly email?: string;
  readonly planType?: string;
  readonly models?: string[];
}

interface QueuedTokenFailure {
  readonly grantType?: TokenGrantType;
  readonly failure: TokenFailure;
  readonly delayMs?: number;
}

const DEFAULT_MODELS = ['gpt-5.5', 'gpt-5.4-mini'];
const INITIAL_REFRESH_TOKEN = 'refresh-token-1';
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export class FakeChatGptServer {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly authBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly tokenRequests: RecordedChatGptTokenRequest[] = [];
  readonly authorizeRequests: RecordedChatGptAuthorizeRequest[] = [];
  readonly backendRequests: RecordedChatGptBackendRequest[] = [];

  private readonly accountId: string;
  private readonly email: string;
  private readonly planType: string;
  private readonly models: string[];
  private readonly validRefreshTokens = new Set([INITIAL_REFRESH_TOKEN]);
  private tokenSequence = 1;
  private queuedTokenFailures: QueuedTokenFailure[] = [];
  private responseScripts: FakeChatGptResponsesScript[] = [];

  /** Served on GET /wham/usage when set; 404 otherwise. */
  usagePayload: Record<string, unknown> | null = null;
  /** Served on GET /wham/rate-limit-reset-credits when set; 404 otherwise. */
  resetCreditsPayload: Record<string, unknown> | null = null;
  /** Served on GET /wham/profiles/me when set; 404 otherwise. */
  profilePayload: Record<string, unknown> | null = null;
  /** Credits the consume endpoint can still redeem; each `reset` decrements. */
  resetCreditsAvailable = 0;
  /** HTTP status the next consume request fails with; null serves normally. */
  consumeFailureStatus: number | null = null;
  /** Raw body override for consume responses (e.g. an unknown outcome code). */
  consumeBodyOverride: Record<string, unknown> | null = null;

  private readonly redeemedRequestIds = new Set<string>();

  tokenDelayMs = 0;

  constructor(options: FakeChatGptServerOptions = {}) {
    this.accountId = options.accountId ?? TEST_ACCOUNT_ID;
    this.email = options.email ?? TEST_EMAIL;
    this.planType = options.planType ?? 'plus';
    this.models = options.models ?? DEFAULT_MODELS;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.authBaseUrl = `http://127.0.0.1:${this.server.port}`;
    this.apiBaseUrl = this.authBaseUrl;
  }

  get initialRefreshToken(): string {
    return INITIAL_REFRESH_TOKEN;
  }

  get currentRefreshToken(): string {
    return `refresh-token-${this.tokenSequence}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  queueTokenFailure(failure: QueuedTokenFailure): void {
    this.queuedTokenFailures.push(failure);
  }

  queueResponsesScript(script: FakeChatGptResponsesScript): void {
    this.responseScripts.push(script);
  }

  queueResponsesScripts(scripts: FakeChatGptResponsesScript[]): void {
    this.responseScripts.push(...scripts);
  }

  countTokenRequests(grantType?: TokenGrantType): number {
    return this.tokenRequests.filter((request) => !grantType || request.grantType === grantType)
      .length;
  }

  private handle(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      return this.handleAuthorize(url);
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      return this.handleToken(request);
    }
    if (request.method === 'GET' && url.pathname === '/models') {
      return Response.json({ models: this.models });
    }
    if (request.method === 'POST' && url.pathname === '/responses') {
      return this.handleResponses(request);
    }
    if (request.method === 'GET' && url.pathname === '/wham/usage') {
      return this.handleWhamPayload(request, this.usagePayload);
    }
    if (request.method === 'GET' && url.pathname === '/wham/rate-limit-reset-credits') {
      return this.handleWhamPayload(request, this.resetCreditsPayload);
    }
    if (request.method === 'POST' && url.pathname === '/wham/rate-limit-reset-credits/consume') {
      return this.handleConsume(request);
    }
    if (request.method === 'GET' && url.pathname === '/wham/profiles/me') {
      return this.handleWhamPayload(request, this.profilePayload);
    }
    return new Response('Not found', { status: 404 });
  }

  private handleAuthorize(url: URL): Response {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    this.authorizeRequests.push({
      state,
      redirectUri,
      codeChallenge: url.searchParams.get('code_challenge'),
    });
    if (!redirectUri) {
      return Response.json({ error: 'missing redirect_uri' }, { status: 400 });
    }

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', `fake-code-${this.authorizeRequests.length}`);
    if (state) redirect.searchParams.set('state', state);
    return Response.redirect(redirect.toString(), 302);
  }

  private async handleToken(request: Request): Promise<Response> {
    const body = new URLSearchParams(await request.text());
    const grantType = body.get('grant_type') ?? '';
    const refreshToken = body.get('refresh_token');
    this.tokenRequests.push({
      grantType,
      code: body.get('code'),
      refreshToken,
    });

    const failure = this.takeTokenFailure(grantType);
    if (failure?.failure === 'slow-response') {
      await Bun.sleep(failure.delayMs ?? 100);
    } else if (this.tokenDelayMs > 0) {
      await Bun.sleep(this.tokenDelayMs);
    }
    if (failure?.failure === 'server-error') {
      return new Response('boom', { status: 500 });
    }
    if (failure?.failure === 'invalid-grant') {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }

    if (grantType === 'authorization_code') {
      return Response.json(this.createTokenPayload(INITIAL_REFRESH_TOKEN));
    }

    if (grantType === 'refresh_token') {
      if (!refreshToken || !this.validRefreshTokens.has(refreshToken)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      this.validRefreshTokens.delete(refreshToken);
      this.tokenSequence += 1;
      const rotated = this.currentRefreshToken;
      this.validRefreshTokens.add(rotated);
      return Response.json(this.createTokenPayload(rotated));
    }

    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  private takeTokenFailure(grantType: string): QueuedTokenFailure | undefined {
    const index = this.queuedTokenFailures.findIndex(
      (failure) => !failure.grantType || failure.grantType === grantType
    );
    if (index === -1) return undefined;
    return this.queuedTokenFailures.splice(index, 1)[0];
  }

  private createTokenPayload(refreshToken: string): Record<string, unknown> {
    return {
      access_token: makeAccessToken(
        {
          jti: `access-token-${this.tokenSequence}`,
          'https://api.openai.com/auth': {
            chatgpt_account_id: this.accountId,
            chatgpt_plan_type: this.planType,
          },
        },
        this.accountId
      ),
      refresh_token: refreshToken,
      id_token: makeIdToken(this.email),
      expires_in: DEFAULT_EXPIRES_IN_SECONDS,
    };
  }

  private async handleResponses(request: Request): Promise<Response> {
    this.backendRequests.push({
      path: new URL(request.url).pathname,
      headers: {
        authorization: request.headers.get('authorization'),
        'chatgpt-account-id': request.headers.get('chatgpt-account-id'),
        'openai-beta': request.headers.get('openai-beta'),
        originator: request.headers.get('originator'),
        session_id: request.headers.get('session_id'),
      },
      body: (await request.json().catch(() => ({}))) as Record<string, unknown>,
    });

    const script = this.responseScripts.shift() ?? {
      type: 'events',
      events: textResponseEvents('fake response'),
    };

    if (script.type === 'status') {
      return Response.json(script.body ?? { error: { message: 'scripted failure' } }, {
        status: script.status,
      });
    }

    if (script.type === 'malformed') {
      return malformedSseResponse(script.events ?? [], script.raw);
    }

    return sseResponse(script.events, script.headers);
  }

  /**
   * Stateful consume endpoint mirroring the backend's idempotency semantics:
   * a replayed redeem_request_id answers `already_redeemed`, an exhausted
   * credit pool answers `no_credit`, otherwise one credit is spent.
   */
  private async handleConsume(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    this.backendRequests.push({
      path: new URL(request.url).pathname,
      headers: {
        authorization: request.headers.get('authorization'),
        'chatgpt-account-id': request.headers.get('chatgpt-account-id'),
        'openai-beta': request.headers.get('openai-beta'),
        originator: request.headers.get('originator'),
        session_id: request.headers.get('session_id'),
      },
      body,
    });

    if (this.consumeFailureStatus !== null) {
      const status = this.consumeFailureStatus;
      this.consumeFailureStatus = null;
      return Response.json({ error: 'scripted consume failure' }, { status });
    }
    if (this.consumeBodyOverride) {
      const override = this.consumeBodyOverride;
      this.consumeBodyOverride = null;
      return Response.json(override);
    }

    const redeemRequestId = body.redeem_request_id;
    if (typeof redeemRequestId !== 'string' || redeemRequestId === '') {
      return Response.json({ error: 'missing redeem_request_id' }, { status: 400 });
    }
    if (this.redeemedRequestIds.has(redeemRequestId)) {
      return Response.json({ code: 'already_redeemed', windows_reset: 0 });
    }
    if (this.resetCreditsAvailable <= 0) {
      return Response.json({ code: 'no_credit', windows_reset: 0 });
    }
    this.redeemedRequestIds.add(redeemRequestId);
    this.resetCreditsAvailable -= 1;
    return Response.json({ code: 'reset', windows_reset: 1 });
  }

  private handleWhamPayload(request: Request, payload: Record<string, unknown> | null): Response {
    this.backendRequests.push({
      path: new URL(request.url).pathname,
      headers: {
        authorization: request.headers.get('authorization'),
        'chatgpt-account-id': request.headers.get('chatgpt-account-id'),
        'openai-beta': request.headers.get('openai-beta'),
        originator: request.headers.get('originator'),
        session_id: request.headers.get('session_id'),
      },
      body: {},
    });
    if (!payload) return new Response('Not found', { status: 404 });
    return Response.json(payload);
  }
}

export function startFakeChatGptServer(options?: FakeChatGptServerOptions): FakeChatGptServer {
  return new FakeChatGptServer(options);
}

function sseResponse(
  events: Array<Record<string, unknown>>,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...extraHeaders },
  });
}

export function textResponseEvents(text: string, id = 'resp_text'): Array<Record<string, unknown>> {
  return [
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id,
        usage: { input_tokens: 10, output_tokens: 4 },
        output: [
          {
            type: 'message',
            id: `${id}_msg`,
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ],
      },
    },
  ];
}

export function toolCallResponseEvents(options: {
  readonly callId: string;
  readonly itemId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly responseId?: string;
}): Array<Record<string, unknown>> {
  const responseId = options.responseId ?? 'resp_tool';
  return [
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: options.itemId,
        call_id: options.callId,
        name: options.name,
      },
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: options.itemId,
      arguments: options.argumentsJson,
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: { input_tokens: 16, output_tokens: 4 },
        output: [
          {
            type: 'reasoning',
            id: `${responseId}_reasoning`,
            encrypted_content: `${responseId}_encrypted`,
            summary: [{ type: 'summary_text', text: 'Need a tool result.' }],
          },
          {
            type: 'function_call',
            id: options.itemId,
            call_id: options.callId,
            name: options.name,
            arguments: options.argumentsJson,
          },
        ],
      },
    },
  ];
}

function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function malformedSseResponse(events: Array<Record<string, unknown>>, raw = 'data: {broken\n\n') {
  return new Response(`${sseBody(events)}${raw}`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
