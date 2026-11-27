import { describe, expect, test } from 'bun:test';

import {
  ADVISORY_RETRY_POLICY,
  ARTIFACT_DOWNLOAD_RETRY_POLICY,
  GitHubHttpFailure,
  GitHubNetworkFailure,
  GitHubRetriesExhausted,
  GitHubRetry,
  IncompleteListing,
  malformedResponse,
  parseJsonReply,
  sendGitHubRequest,
  STANDARD_RETRY_POLICY,
  UnstableListing,
} from '../lib/github-retry';
import { RecordedRetryEnvironment, ScriptedGitHubHttp } from './support/scripted-github-http';

function fixture() {
  const environment = new RecordedRetryEnvironment();
  return { environment, retry: new GitHubRetry(STANDARD_RETRY_POLICY, environment) };
}

function headersOf(values: Record<string, string>) {
  return (name: string): string | undefined => values[name];
}

/** Fails with `failures` in order, then returns 'ok'. */
function failingThenOk(failures: Error[]): { attempt: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    attempt: () => {
      const failure = failures[calls++];
      return failure ? Promise.reject(failure) : Promise.resolve('ok');
    },
    calls: () => calls,
  };
}

describe('GitHubRetry.request', () => {
  test('retries a 502 after the first backoff and returns the later success', async () => {
    const { retry, environment } = fixture();
    const script = failingThenOk([new GitHubHttpFailure('GET /x returned 502', 502)]);
    expect(await retry.request('GET /x', script.attempt, { idempotent: true })).toBe('ok');
    expect(script.calls()).toBe(2);
    expect(environment.waits).toEqual([5_000]);
  });

  test('retries a network error', async () => {
    const { retry, environment } = fixture();
    const script = failingThenOk([
      new GitHubNetworkFailure('reset'),
      new GitHubNetworkFailure('reset'),
    ]);
    expect(await retry.request('GET /x', script.attempt, { idempotent: true })).toBe('ok');
    expect(environment.waits).toEqual([5_000, 10_000]);
  });

  test('a persistent 503 stops after three attempts and names the status and the attempts', async () => {
    const { retry, environment } = fixture();
    const failure = new GitHubHttpFailure('GET /x returned 503; expected 2xx', 503);
    const script = failingThenOk([failure, failure, failure, failure]);
    const thrown = await retry
      .request('GET /x', script.attempt, { idempotent: true })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(GitHubRetriesExhausted);
    expect((thrown as Error).message).toBe(
      'GET /x returned 503; expected 2xx; GET /x gave up after 3 attempts (attempt schedule spent)'
    );
    expect(script.calls()).toBe(3);
    expect(environment.waits).toEqual([5_000, 10_000]);
  });

  test.each([400, 401, 403, 404, 422])('does not retry HTTP %i', async (status) => {
    const { retry, environment } = fixture();
    const failure = new GitHubHttpFailure(`GET /x returned ${status}`, status);
    const script = failingThenOk([failure]);
    await expect(retry.request('GET /x', script.attempt, { idempotent: true })).rejects.toBe(
      failure
    );
    expect(script.calls()).toBe(1);
    expect(environment.waits).toEqual([]);
  });

  test('a write is not repeated after a 5xx or a network error, which may have been processed', async () => {
    for (const failure of [
      new GitHubHttpFailure('POST /issues returned 502', 502),
      new GitHubNetworkFailure('timed out'),
    ]) {
      const { retry, environment } = fixture();
      const script = failingThenOk([failure]);
      await expect(
        retry.request('POST /issues', script.attempt, { idempotent: false })
      ).rejects.toBe(failure);
      expect(script.calls()).toBe(1);
      expect(environment.waits).toEqual([]);
    }
  });

  test('a write is retried after a 429, which GitHub rejects before processing', async () => {
    const { retry, environment } = fixture();
    const script = failingThenOk([
      new GitHubHttpFailure('POST /issues returned 429', 429, headersOf({ 'retry-after': '7' })),
    ]);
    expect(await retry.request('POST /issues', script.attempt, { idempotent: false })).toBe('ok');
    expect(environment.waits).toEqual([7_000]);
  });

  test('honors Retry-After in seconds when it is longer than the backoff', async () => {
    const { retry, environment } = fixture();
    const script = failingThenOk([
      new GitHubHttpFailure('GET /x returned 429', 429, headersOf({ 'retry-after': '20' })),
    ]);
    await retry.request('GET /x', script.attempt, { idempotent: true });
    expect(environment.waits).toEqual([20_000]);
  });

  test('keeps the scheduled backoff when Retry-After is shorter', async () => {
    const { retry, environment } = fixture();
    const script = failingThenOk([
      new GitHubHttpFailure('GET /x returned 429', 429, headersOf({ 'retry-after': '1' })),
    ]);
    await retry.request('GET /x', script.attempt, { idempotent: true });
    expect(environment.waits).toEqual([5_000]);
  });

  test('honors a Retry-After HTTP date against the injected clock', async () => {
    const { retry, environment } = fixture();
    const date = new Date(environment.now() + 12_000).toUTCString();
    const script = failingThenOk([
      new GitHubHttpFailure('GET /x returned 429', 429, headersOf({ 'retry-after': date })),
    ]);
    await retry.request('GET /x', script.attempt, { idempotent: true });
    expect(environment.waits).toEqual([12_000]);
  });

  test('retries a 403 naming the secondary rate limit but not a plain 403', async () => {
    const limited = fixture();
    const secondary = failingThenOk([
      new GitHubHttpFailure(
        'GET /x returned 403',
        403,
        undefined,
        '{"message":"You have exceeded a secondary rate limit."}'
      ),
    ]);
    expect(await limited.retry.request('GET /x', secondary.attempt, { idempotent: true })).toBe(
      'ok'
    );
    expect(limited.environment.waits).toEqual([5_000]);

    const plain = fixture();
    const forbidden = new GitHubHttpFailure(
      'GET /x returned 403',
      403,
      undefined,
      '{"message":"Resource not accessible by integration"}'
    );
    await expect(
      plain.retry.request('GET /x', failingThenOk([forbidden]).attempt, { idempotent: true })
    ).rejects.toBe(forbidden);
    expect(plain.environment.waits).toEqual([]);
  });

  test('waits for x-ratelimit-reset when the quota is spent and the reset is near', async () => {
    const { retry, environment } = fixture();
    const reset = Math.ceil((environment.now() + 25_000) / 1000);
    const script = failingThenOk([
      new GitHubHttpFailure(
        'GET /x returned 403',
        403,
        headersOf({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
      ),
    ]);
    await retry.request('GET /x', script.attempt, { idempotent: true });
    expect(environment.waits).toHaveLength(1);
    expect(environment.waits[0]).toBeGreaterThanOrEqual(24_000);
    expect(environment.waits[0]).toBeLessThanOrEqual(25_000);
  });

  test('refuses to sleep through a reset beyond the cap and says so', async () => {
    const { retry, environment } = fixture();
    const reset = Math.ceil((environment.now() + 3_600_000) / 1000);
    const script = failingThenOk([
      new GitHubHttpFailure(
        'GET /x returned 403',
        403,
        headersOf({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
      ),
    ]);
    await expect(retry.request('GET /x', script.attempt, { idempotent: true })).rejects.toThrow(
      'GET /x returned 403; GET /x gave up after 1 attempts (server asked for 3600 s, over the 30 s cap)'
    );
    expect(environment.waits).toEqual([]);
  });

  test('the wait budget is shared, so many failing calls cannot add up past it', async () => {
    const { retry, environment } = fixture();
    const failure = new GitHubHttpFailure('GET /x returned 502', 502);
    for (let call = 0; call < 4; call++) {
      await retry
        .request('GET /x', failingThenOk([failure, failure, failure]).attempt, {
          idempotent: true,
        })
        .catch(() => undefined);
    }
    expect(environment.waits.reduce((sum, wait) => sum + wait, 0)).toBe(60_000);
    await expect(
      retry.request('GET /x', failingThenOk([failure, failure]).attempt, { idempotent: true })
    ).rejects.toThrow('gave up after 1 attempts (60 s wait budget spent)');
    expect(environment.waits).toHaveLength(8);
  });

  test('stops retrying once the caller aborts', async () => {
    const { retry, environment } = fixture();
    const controller = new AbortController();
    controller.abort();
    const failure = new GitHubNetworkFailure('aborted');
    const script = failingThenOk([failure]);
    await expect(
      retry.request('GET /x', script.attempt, { idempotent: true, signal: controller.signal })
    ).rejects.toBe(failure);
    expect(environment.waits).toEqual([]);
  });

  test('every preset fits the budget its comment states', () => {
    for (const policy of [
      STANDARD_RETRY_POLICY,
      ADVISORY_RETRY_POLICY,
      ARTIFACT_DOWNLOAD_RETRY_POLICY,
    ]) {
      const scheduled = policy.backoffMs.reduce((sum, wait) => sum + wait, 0);
      expect(scheduled).toBeLessThanOrEqual(policy.maxTotalWaitMs);
      expect(Math.max(...policy.backoffMs)).toBeLessThanOrEqual(policy.maxServerWaitMs);
    }
    expect(ADVISORY_RETRY_POLICY.maxTotalWaitMs).toBeLessThanOrEqual(1_000);
  });
});

describe('GitHubRetry.listing', () => {
  function listingReads(results: Array<Error | string>) {
    let passes = 0;
    return {
      read: () => {
        const result = results[Math.min(passes++, results.length - 1)];
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
      passes: () => passes,
    };
  }

  test('two incomplete passes then a complete one returns the complete listing', async () => {
    const { retry, environment } = fixture();
    const script = listingReads([
      new IncompleteListing('Incomplete workflow_runs listing 4/7; expected every entry'),
      new IncompleteListing('Incomplete workflow_runs listing 0/1; expected every entry'),
      'complete',
    ]);
    expect(await retry.listing('workflow_runs', script.read)).toBe('complete');
    expect(script.passes()).toBe(3);
    expect(environment.waits).toEqual([5_000, 10_000]);
  });

  test('persistent incompleteness fails closed after three passes and names the listing', async () => {
    const { retry, environment } = fixture();
    const script = listingReads([
      new IncompleteListing('Incomplete actions_caches listing 1/2; expected every entry'),
    ]);
    const thrown = await retry
      .listing('actions_caches', script.read)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(GitHubRetriesExhausted);
    expect((thrown as Error).message).toContain('Incomplete actions_caches listing 1/2');
    expect(script.passes()).toBe(3);
    expect(environment.waits).toEqual([5_000, 10_000]);
  });

  test('an unstable listing shares the incomplete listing budget instead of nesting', async () => {
    const { retry } = fixture();
    const script = listingReads([
      new UnstableListing('Changing actions_caches total 8 -> 9'),
      new IncompleteListing('Incomplete actions_caches listing 8/9'),
      new UnstableListing('Changing actions_caches total 9 -> 10'),
    ]);
    await expect(retry.listing('actions_caches', script.read)).rejects.toThrow(
      'Changing actions_caches total 9 -> 10'
    );
    expect(script.passes()).toBe(3);
  });

  test('any other failure is not retried', async () => {
    const { retry, environment } = fixture();
    const failure = new Error('Invalid cache entry null; expected an object');
    const script = listingReads([failure]);
    await expect(retry.listing('actions_caches', script.read)).rejects.toBe(failure);
    expect(script.passes()).toBe(1);
    expect(environment.waits).toEqual([]);
  });

  test('a request that already gave up is not retried again by the listing layer', async () => {
    const { retry } = fixture();
    const failure = new GitHubHttpFailure('GET /caches returned 502', 502);
    let passes = 0;
    await expect(
      retry.listing('actions_caches', () =>
        retry.request(
          'GET /caches',
          () => {
            passes++;
            return Promise.reject(failure);
          },
          { idempotent: true }
        )
      )
    ).rejects.toBeInstanceOf(GitHubRetriesExhausted);
    expect(passes).toBe(3);
  });
});

describe('GitHubRetry gh transport', () => {
  const failed = (stderr: string) => ({ exitCode: 1, stderr });
  const ok = { exitCode: 0, stderr: '' };

  function results(...queue: Array<{ exitCode: number; stderr: string }>) {
    let calls = 0;
    return {
      run: () => queue[Math.min(calls++, queue.length - 1)],
      calls: () => calls,
    };
  }

  test.each([
    'gh: Bad Gateway (HTTP 502)',
    'gh: rate limit (HTTP 429)',
    'Get "<url>": unexpected EOF',
    'gh: You have exceeded a secondary rate limit (HTTP 403)',
  ])('rereads after transient stderr %j', async (stderr) => {
    const { retry, environment } = fixture();
    const script = results(failed(stderr), ok);
    expect(await retry.ghCommand(script.run)).toEqual(ok);
    expect(environment.waits).toEqual([5_000]);
  });

  test.each([
    'gh: Resource not accessible by integration (HTTP 403)',
    'gh: Not Found (HTTP 404)',
    '',
  ])('does not reread after %j', async (stderr) => {
    const { retry, environment } = fixture();
    const script = results(failed(stderr), ok);
    expect(await retry.ghCommand(script.run)).toEqual(failed(stderr));
    expect(script.calls()).toBe(1);
    expect(environment.waits).toEqual([]);
  });

  test('a persistent failure returns the last result after three reads', async () => {
    const { retry } = fixture();
    const script = results(failed('gh: Gateway Timeout (HTTP 504)'));
    expect(await retry.ghCommand(script.run)).toEqual(failed('gh: Gateway Timeout (HTTP 504)'));
    expect(script.calls()).toBe(3);
  });

  test('a write command is not reread after a 502', async () => {
    const { retry } = fixture();
    const script = results(failed('gh: Bad Gateway (HTTP 502)'), ok);
    await retry.ghCommand(script.run, { idempotent: false });
    expect(script.calls()).toBe(1);
  });

  test('outcome honors Retry-After taken from parsed headers', async () => {
    const { retry, environment } = fixture();
    const replies = [{ status: 429 }, { status: 200 }];
    const result = await retry.outcome(
      () => replies.shift() as { status: number },
      (reply) =>
        reply.status === 429
          ? new GitHubHttpFailure('HTTP 429', 429, headersOf({ 'retry-after': '9' }))
          : undefined,
      true
    );
    expect(result).toEqual({ status: 200 });
    expect(environment.waits).toEqual([9_000]);
  });
});

describe('GitHubRetry.anyFailure', () => {
  test('retries any failure once after the policy wait and logs each failure', async () => {
    const environment = new RecordedRetryEnvironment();
    const retry = new GitHubRetry(ARTIFACT_DOWNLOAD_RETRY_POLICY, environment);
    const log: string[] = [];
    const script = failingThenOk([new Error('digest mismatch')]);
    expect(await retry.anyFailure('Artifact 7', script.attempt, (line) => log.push(line))).toBe(
      'ok'
    );
    expect(environment.waits).toEqual([2_000]);
    expect(log).toEqual(['::warning::Artifact 7 attempt 1 failed: digest mismatch']);
  });

  test('rethrows the last failure when every attempt failed', async () => {
    const environment = new RecordedRetryEnvironment();
    const retry = new GitHubRetry(ARTIFACT_DOWNLOAD_RETRY_POLICY, environment);
    const last = new Error('second');
    await expect(
      retry.anyFailure('Artifact 7', failingThenOk([new Error('first'), last]).attempt, () => {})
    ).rejects.toBe(last);
  });
});

describe('response shape errors', () => {
  test('a non-JSON 200 names the request, page, expected shape and the body received', () => {
    const reply = { status: 200, header: () => undefined, text: '<html>Unicorn</html>' };
    expect(() =>
      parseJsonReply(reply, { request: 'GET /caches', page: 3 }, 'a cache listing object')
    ).toThrow(
      'Invalid GET /caches page 3; expected a cache listing object as JSON (HTTP 200) | received <html>Unicorn</html>'
    );
  });

  test('a long body is truncated with its length and an empty one says so', () => {
    const long = malformedResponse({ request: 'GET /x' }, 'an array', 'x'.repeat(500));
    expect(long.message).toBe(
      `Invalid GET /x; expected an array | received ${'x'.repeat(200)}... (500 chars)`
    );
    expect(malformedResponse({ request: 'GET /x' }, 'an array', '').message).toContain(
      'received <empty>'
    );
  });

  test('a parsed value is rendered as JSON', () => {
    expect(
      malformedResponse({ request: 'GET /x', page: 1 }, 'an array', { message: 'no' }).message
    ).toBe('Invalid GET /x page 1; expected an array | received {"message":"no"}');
  });
});

describe('sendGitHubRequest', () => {
  const REPLY_TIMEOUT = () => ({ method: 'GET' });

  async function send(
    http: ScriptedGitHubHttp,
    environment: RecordedRetryEnvironment,
    idempotent = true
  ) {
    return sendGitHubRequest(
      new GitHubRetry(STANDARD_RETRY_POLICY, environment),
      (url, init) => http.request(url, init),
      {
        label: 'GET /x',
        url: 'https://api.github.com/x',
        init: REPLY_TIMEOUT,
        idempotent,
        failure: (status) => `GET /x returned ${status}; expected a successful response`,
      }
    );
  }

  test('a 502 then a 200 returns the 200 and waited once', async () => {
    const http = new ScriptedGitHubHttp();
    http.replies = [
      { status: 502, text: 'Bad Gateway' },
      { status: 200, body: { ok: true } },
    ];
    const environment = new RecordedRetryEnvironment();
    const reply = await send(http, environment);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ ok: true });
    expect(http.calls).toHaveLength(2);
    expect(environment.waits).toEqual([5_000]);
  });

  test('a rejected fetch is a retried network failure', async () => {
    const http = new ScriptedGitHubHttp();
    http.replies = [{ networkError: 'socket closed' }, { status: 200, body: [] }];
    const environment = new RecordedRetryEnvironment();
    expect((await send(http, environment)).status).toBe(200);
    expect(environment.waits).toEqual([5_000]);
  });

  test('a 404 stays an error unless the caller accepts it', async () => {
    const http = new ScriptedGitHubHttp();
    http.replies = [{ status: 404, body: {} }];
    await expect(send(http, new RecordedRetryEnvironment())).rejects.toThrow(
      'GET /x returned 404; expected a successful response'
    );
  });

  test('Retry-After on a 429 is read from the response headers', async () => {
    const http = new ScriptedGitHubHttp();
    http.replies = [
      { status: 429, headers: { 'retry-after': '11' }, body: { message: 'slow down' } },
      { status: 200, body: {} },
    ];
    const environment = new RecordedRetryEnvironment();
    await send(http, environment);
    expect(environment.waits).toEqual([11_000]);
  });
});
