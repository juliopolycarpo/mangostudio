import { afterEach, describe, expect, it } from 'bun:test';
import {
  captureChatGptUsageHeaders,
  getChatGptUsageSnapshot,
  isChatGptUsageStale,
  parseChatGptProfileStats,
  parseChatGptRedeemResponse,
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

describe('parseChatGptUsageHeaders promo message', () => {
  it('captures x-codex-promo-message and counts it as telemetry', () => {
    const headers = new Headers({ 'x-codex-promo-message': 'Try the new plan!' });
    expect(parseChatGptUsageHeaders(headers, NOW)).toEqual({
      capturedAt: NOW,
      source: 'headers',
      promoMessage: 'Try the new plan!',
    });
  });
});

describe('parseChatGptRedeemResponse', () => {
  it.each([
    'reset',
    'nothing_to_reset',
    'no_credit',
    'already_redeemed',
  ] as const)('accepts the %s outcome', (code) => {
    expect(parseChatGptRedeemResponse({ code, windows_reset: 2 })).toEqual({
      code,
      windowsReset: 2,
    });
  });

  it('coerces a numeric-string windows_reset and defaults a missing one to 0', () => {
    expect(parseChatGptRedeemResponse({ code: 'reset', windows_reset: '1' })).toEqual({
      code: 'reset',
      windowsReset: 1,
    });
    expect(parseChatGptRedeemResponse({ code: 'nothing_to_reset' })).toEqual({
      code: 'nothing_to_reset',
      windowsReset: 0,
    });
  });

  it('returns null for unknown outcome codes and non-object payloads', () => {
    expect(parseChatGptRedeemResponse({ code: 'mystery', windows_reset: 1 })).toBe(null);
    expect(parseChatGptRedeemResponse({ windows_reset: 1 })).toBe(null);
    expect(parseChatGptRedeemResponse('reset')).toBe(null);
    expect(parseChatGptRedeemResponse(null)).toBe(null);
  });
});

describe('parseChatGptProfileStats', () => {
  it('parses a full stats block and sorts daily buckets ascending', () => {
    expect(
      parseChatGptProfileStats({
        stats: {
          lifetime_tokens: 1_234_567,
          peak_daily_tokens: '9000',
          longest_running_turn_sec: 320,
          current_streak_days: 4,
          longest_streak_days: 11,
          daily_usage_buckets: [
            { start_date: '2026-07-02', tokens: 300 },
            { start_date: '2026-07-01', tokens: '200' },
          ],
        },
      })
    ).toEqual({
      lifetimeTokens: 1_234_567,
      peakDailyTokens: 9000,
      longestRunningTurnSec: 320,
      currentStreakDays: 4,
      longestStreakDays: 11,
      dailyUsage: [
        { startDate: '2026-07-01', tokens: 200 },
        { startDate: '2026-07-02', tokens: 300 },
      ],
    });
  });

  it('parses daily buckets lossily and tolerates a partial stats block', () => {
    expect(
      parseChatGptProfileStats({
        stats: {
          current_streak_days: 2,
          daily_usage_buckets: [
            'garbage',
            { start_date: '', tokens: 5 },
            { start_date: '2026-07-01' },
            { start_date: '2026-07-02', tokens: 'broken' },
          ],
        },
      })
    ).toEqual({ currentStreakDays: 2 });
  });

  it('returns null when stats are absent, empty, or the payload is malformed', () => {
    expect(parseChatGptProfileStats({})).toBe(null);
    expect(parseChatGptProfileStats({ stats: {} })).toBe(null);
    expect(parseChatGptProfileStats({ stats: 'nope' })).toBe(null);
    expect(parseChatGptProfileStats(null)).toBe(null);
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

  it('keeps the last promo message when a newer snapshot omits it', () => {
    recordChatGptUsageSnapshot('acct', {
      capturedAt: NOW,
      source: 'headers',
      promoMessage: 'Try the new plan!',
    });
    recordChatGptUsageSnapshot('acct', { capturedAt: NOW + 1000, source: 'endpoint' });
    expect(getChatGptUsageSnapshot('acct')).toEqual({
      capturedAt: NOW + 1000,
      source: 'endpoint',
      promoMessage: 'Try the new plan!',
    });

    recordChatGptUsageSnapshot('acct', {
      capturedAt: NOW + 2000,
      source: 'headers',
      promoMessage: 'Newer promo',
    });
    expect(getChatGptUsageSnapshot('acct')?.promoMessage).toBe('Newer promo');
  });

  it('captureChatGptUsageHeaders stores only responses that carry telemetry', () => {
    captureChatGptUsageHeaders('acct', new Headers({ 'content-type': 'application/json' }));
    expect(getChatGptUsageSnapshot('acct')).toBe(null);

    captureChatGptUsageHeaders('acct', new Headers({ 'x-codex-primary-used-percent': '7' }));
    expect(getChatGptUsageSnapshot('acct')?.primary?.usedPercent).toBe(7);
  });
});
