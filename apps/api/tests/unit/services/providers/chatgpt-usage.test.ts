import { afterEach, describe, expect, it } from 'bun:test';
import {
  captureChatGptUsageHeaders,
  getChatGptUsageSnapshot,
  isChatGptUsageStale,
  parseChatGptResetCreditsPayload,
  parseChatGptUsageHeaders,
  parseChatGptUsagePayload,
  recordChatGptUsageSnapshot,
  resetChatGptUsageStoreForTests,
} from '../../../../src/services/providers/chatgpt/usage';

const NOW = 1_750_000_000_000;

afterEach(() => {
  resetChatGptUsageStoreForTests();
});

describe('parseChatGptUsageHeaders', () => {
  it('parses primary/secondary windows, credits, and limit-reached', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(NOW / 1000 + 3600),
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '12.5',
      'x-codex-rate-limit-reached-type': 'primary',
    });

    expect(parseChatGptUsageHeaders(headers, NOW)).toEqual({
      capturedAt: NOW,
      source: 'headers',
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
      secondary: { usedPercent: 10, windowMinutes: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: 12.5 },
      limitReached: true,
    });
  });

  it('returns null when no usage headers are present', () => {
    expect(parseChatGptUsageHeaders(new Headers({ 'content-type': 'text/event-stream' }))).toBe(
      null
    );
  });

  it('omits malformed fields without discarding the rest', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': 'not-a-number',
      'x-codex-secondary-used-percent': '55',
      'x-codex-secondary-reset-at': 'garbage',
      'x-codex-credits-balance': 'NaN',
    });

    expect(parseChatGptUsageHeaders(headers, NOW)).toEqual({
      capturedAt: NOW,
      source: 'headers',
      secondary: { usedPercent: 55 },
    });
  });

  it('ignores extra x-<limit-id>-* families without failing', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '5',
      'x-gpt5-image-primary-used-percent': '90',
      'x-gpt5-image-limit-name': 'Image generation',
    });

    expect(parseChatGptUsageHeaders(headers, NOW)).toEqual({
      capturedAt: NOW,
      source: 'headers',
      primary: { usedPercent: 5 },
    });
  });
});

describe('parseChatGptUsagePayload', () => {
  it('parses a full /wham/usage payload', () => {
    const snapshot = parseChatGptUsagePayload(
      {
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 33,
            limit_window_seconds: 18_000,
            reset_after_seconds: 1200,
          },
          secondary_window: {
            used_percent: '66.5',
            limit_window_seconds: '604800',
            reset_at: NOW / 1000 + 86_400,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: '3.25' },
        rate_limit_reset_credits: { available_count: 2 },
        additional_rate_limits: [
          { limit_name: 'Image generation', rate_limit: { primary_window: { used_percent: 80 } } },
        ],
      },
      NOW
    );

    expect(snapshot).toEqual({
      capturedAt: NOW,
      source: 'endpoint',
      planType: 'plus',
      primary: { usedPercent: 33, windowMinutes: 300, resetsAt: NOW + 1_200_000 },
      secondary: { usedPercent: 66.5, windowMinutes: 10_080, resetsAt: NOW + 86_400_000 },
      limitReached: false,
      credits: { hasCredits: true, unlimited: false, balance: 3.25 },
      resetCredits: { availableCount: 2 },
      additionalLimits: [{ limitName: 'Image generation', window: { usedPercent: 80 } }],
    });
  });

  it('tolerates a partial payload and missing rate_limit_reset_credits', () => {
    expect(parseChatGptUsagePayload({ plan_type: 'pro' }, NOW)).toEqual({
      capturedAt: NOW,
      source: 'endpoint',
      planType: 'pro',
    });
  });

  it('parses additional_rate_limits lossily — one malformed entry keeps valid siblings', () => {
    const snapshot = parseChatGptUsagePayload(
      {
        additional_rate_limits: [
          'garbage',
          { rate_limit: { primary_window: { used_percent: 'broken' } } },
          { limit_name: 'Valid', rate_limit: { primary_window: { used_percent: '12' } } },
        ],
      },
      NOW
    );

    expect(snapshot?.additionalLimits).toEqual([
      { limitName: 'Valid', window: { usedPercent: 12 } },
    ]);
  });

  it('derives limitReached from rate_limit_reached_type when rate_limit omits it', () => {
    expect(parseChatGptUsagePayload({ rate_limit_reached_type: 'primary' }, NOW)).toMatchObject({
      limitReached: true,
    });
  });

  it('returns null for non-object payloads', () => {
    expect(parseChatGptUsagePayload(null, NOW)).toBe(null);
    expect(parseChatGptUsagePayload('nope', NOW)).toBe(null);
  });
});

describe('parseChatGptResetCreditsPayload', () => {
  const inOneDay = new Date(NOW + 86_400_000).toISOString();
  const inTwoDays = new Date(NOW + 2 * 86_400_000).toISOString();
  const yesterday = new Date(NOW - 86_400_000).toISOString();

  it('picks the soonest future expiry among available credits', () => {
    expect(
      parseChatGptResetCreditsPayload(
        {
          available_count: 2,
          credits: [
            { status: 'available', expires_at: inTwoDays },
            { status: 'available', expires_at: inOneDay },
            { status: 'redeemed', expires_at: inOneDay },
          ],
        },
        NOW
      )
    ).toEqual({ availableCount: 2, nextExpiresAt: NOW + 86_400_000 });
  });

  it('treats unknown statuses as opaque and tolerates null expires_at', () => {
    expect(
      parseChatGptResetCreditsPayload(
        {
          available_count: 1,
          credits: [
            { status: 'mystery-status', expires_at: inOneDay },
            { status: 'available', expires_at: null },
          ],
        },
        NOW
      )
    ).toEqual({ availableCount: 1 });
  });

  it('skips past-expiry credits even when status still says available', () => {
    expect(
      parseChatGptResetCreditsPayload(
        { available_count: 1, credits: [{ status: 'available', expires_at: yesterday }] },
        NOW
      )
    ).toEqual({ availableCount: 1 });
  });

  it('falls back to counting available credits when available_count is missing', () => {
    expect(
      parseChatGptResetCreditsPayload(
        { credits: [{ status: 'available' }, { status: 'expired' }] },
        NOW
      )
    ).toEqual({ availableCount: 1 });
  });

  it('returns null for non-object payloads', () => {
    expect(parseChatGptResetCreditsPayload(undefined, NOW)).toBe(null);
  });
});

describe('usage snapshot store', () => {
  it('keeps the newest capturedAt regardless of capture path', () => {
    recordChatGptUsageSnapshot('acct', { capturedAt: NOW, source: 'endpoint' });
    recordChatGptUsageSnapshot('acct', { capturedAt: NOW - 1000, source: 'headers' });
    expect(getChatGptUsageSnapshot('acct')?.source).toBe('endpoint');

    recordChatGptUsageSnapshot('acct', { capturedAt: NOW + 1000, source: 'headers' });
    expect(getChatGptUsageSnapshot('acct')?.source).toBe('headers');
  });

  it('reports staleness after the freshness window', () => {
    const snapshot = { capturedAt: NOW, source: 'endpoint' as const };
    expect(isChatGptUsageStale(snapshot, NOW + 60_000)).toBe(false);
    expect(isChatGptUsageStale(snapshot, NOW + 6 * 60_000)).toBe(true);
  });

  it('captureChatGptUsageHeaders stores only responses that carry telemetry', () => {
    captureChatGptUsageHeaders('acct', new Headers({ 'content-type': 'application/json' }));
    expect(getChatGptUsageSnapshot('acct')).toBe(null);

    captureChatGptUsageHeaders('acct', new Headers({ 'x-codex-primary-used-percent': '7' }));
    expect(getChatGptUsageSnapshot('acct')?.primary?.usedPercent).toBe(7);
  });
});
