/**
 * What the `Accept` header buys a caller.
 *
 * This is the whole opt-in mechanism, and it is attacker-reachable on every
 * request: the header decides which contract a client is held to, and a parser
 * that got it wrong would either break every existing client (by upgrading
 * wildcards) or make the feature unreachable (by ignoring explicit asks). The
 * cases below are the ones a real client population actually sends.
 */

import { describe, expect, it } from 'bun:test';
import {
  LEGACY_ERROR_MEDIA_TYPE,
  PROBLEM_JSON_ACCEPT,
  PROBLEM_JSON_MEDIA_TYPE,
  prefersProblemDetails,
} from '@mangostudio/shared/errors';

describe('prefersProblemDetails', () => {
  it('keeps the legacy shape when nothing was asked for', () => {
    expect(prefersProblemDetails(undefined)).toBe(false);
    expect(prefersProblemDetails(null)).toBe(false);
    expect(prefersProblemDetails('')).toBe(false);
    expect(prefersProblemDetails('   ')).toBe(false);
  });

  it('keeps the legacy shape for wildcards', () => {
    // The load-bearing case. Every client that predates this feature sends one
    // of these, and every one of them must keep the body it was written for.
    expect(prefersProblemDetails('*/*')).toBe(false);
    expect(prefersProblemDetails('application/*')).toBe(false);
    expect(prefersProblemDetails('text/html,application/xhtml+xml;q=0.9,*/*;q=0.8')).toBe(false);
  });

  it('keeps the legacy shape when it is the only thing named', () => {
    expect(prefersProblemDetails(LEGACY_ERROR_MEDIA_TYPE)).toBe(false);
    expect(prefersProblemDetails('application/json;charset=utf-8')).toBe(false);
  });

  it('negotiates when problem details is named outright', () => {
    expect(prefersProblemDetails(PROBLEM_JSON_MEDIA_TYPE)).toBe(true);
    expect(prefersProblemDetails(PROBLEM_JSON_ACCEPT)).toBe(true);
  });

  it('ignores media type case and surrounding whitespace', () => {
    expect(prefersProblemDetails('Application/Problem+JSON')).toBe(true);
    expect(prefersProblemDetails('  application/problem+json  ')).toBe(true);
    expect(prefersProblemDetails('application/json ,  application/problem+json')).toBe(true);
  });

  it('accepts media type parameters', () => {
    expect(prefersProblemDetails('application/problem+json;charset=utf-8')).toBe(true);
    expect(prefersProblemDetails('application/problem+json; charset=utf-8; q=0.9')).toBe(true);
  });

  it('still negotiates for a range carrying parameters it cannot satisfy', () => {
    // Deliberate, and a real narrowing of RFC 9110 §12.5.1: a parameterised
    // range strictly matches only a representation carrying those parameters,
    // and `application/problem+json` has none to carry. Honouring them would
    // turn an outright ask into a silent legacy body, so a named type wins and
    // the parameter is ignored.
    expect(
      prefersProblemDetails('application/problem+json;profile=v2, application/json;q=0.5')
    ).toBe(true);
    expect(prefersProblemDetails('application/problem+json;profile="a b"')).toBe(true);
  });

  it('honours an explicit refusal', () => {
    expect(prefersProblemDetails('application/problem+json;q=0')).toBe(false);
    expect(prefersProblemDetails('application/json, application/problem+json;q=0')).toBe(false);
    expect(prefersProblemDetails('application/problem+json;q=0.0')).toBe(false);
  });

  it('resolves competing ranges by quality', () => {
    expect(prefersProblemDetails('application/json, application/problem+json;q=0.5')).toBe(false);
    expect(prefersProblemDetails('application/json;q=0.5, application/problem+json')).toBe(true);
    expect(prefersProblemDetails('application/json;q=0.5, application/problem+json;q=0.6')).toBe(
      true
    );
    // A tie goes to problem details: naming it at all is the opt-in signal.
    expect(prefersProblemDetails('application/json, application/problem+json')).toBe(true);
  });

  it('weighs an explicit ask against a wildcard for the legacy type', () => {
    expect(prefersProblemDetails('*/*, application/problem+json;q=0.5')).toBe(false);
    expect(prefersProblemDetails('*/*;q=0.5, application/problem+json')).toBe(true);
  });

  it('lets a specific range outrank a higher-quality wildcard', () => {
    // RFC 9110 §12.5.1: the most precise matching range applies, and `q` only
    // breaks ties within one precision. Reading the wildcard's q=1 as the
    // legacy quality here would serve the legacy body to a client that named
    // problem details five times higher than it named JSON.
    expect(
      prefersProblemDetails('application/json;q=0.1, application/problem+json;q=0.5, */*;q=1')
    ).toBe(true);
    // The same rule in the other direction: `application/*` is more precise
    // than `*/*`, so it is the one that speaks for application/json.
    expect(
      prefersProblemDetails('application/*;q=1, application/problem+json;q=0.5, */*;q=0.1')
    ).toBe(false);
  });

  it('does not let a quoted semicolon invent a q parameter', () => {
    // `profile="a;q=0"` carries no quality at all, so the range keeps the
    // default of 1 — splitting it naively reads a synthetic `q=0"` and turns an
    // explicit ask into a refusal.
    expect(prefersProblemDetails('application/problem+json;profile="a;q=0"')).toBe(true);
    expect(prefersProblemDetails('application/problem+json;profile="a;q=0";q=0')).toBe(false);
  });

  it('falls back to the legacy shape on anything unparseable', () => {
    // A header we could not read is not consent, and the safe answer is the
    // representation every client already handles.
    expect(prefersProblemDetails('???')).toBe(false);
    expect(prefersProblemDetails(',,,')).toBe(false);
    expect(prefersProblemDetails('application/')).toBe(false);
    expect(prefersProblemDetails('/json')).toBe(false);
    expect(prefersProblemDetails('application/problem+json;q=')).toBe(true);
    expect(prefersProblemDetails('application/problem+json;q=banana')).toBe(true);
  });

  it('does not let a quoted comma split one range into two', () => {
    expect(prefersProblemDetails('application/problem+json;title="a,b"')).toBe(true);
    expect(prefersProblemDetails('text/plain;title="x,application/problem+json"')).toBe(false);
  });

  it('clamps out-of-range quality values instead of dropping the range', () => {
    expect(prefersProblemDetails('application/problem+json;q=9')).toBe(true);
    expect(prefersProblemDetails('application/json, application/problem+json;q=-1')).toBe(false);
  });

  it('returns in bounded time for a hostile header', () => {
    // The parser is hand-rolled precisely so an attacker-supplied header cannot
    // find a backtracking pattern to sit in.
    const hostile = `${'application/problem+json;q=0.5,'.repeat(20_000)}application/problem+json`;
    const started = Bun.nanoseconds();
    expect(prefersProblemDetails(hostile)).toBe(true);
    expect(Bun.nanoseconds() - started).toBeLessThan(1_000_000_000);
  });

  it('exports an Accept value its own parser rewards', () => {
    // The frontend and the docs both quote this constant; if it ever stopped
    // selecting problem details the opt-in would silently do nothing.
    expect(PROBLEM_JSON_ACCEPT).toContain(PROBLEM_JSON_MEDIA_TYPE);
    expect(PROBLEM_JSON_ACCEPT).toContain(LEGACY_ERROR_MEDIA_TYPE);
    expect(prefersProblemDetails(PROBLEM_JSON_ACCEPT)).toBe(true);
  });
});
