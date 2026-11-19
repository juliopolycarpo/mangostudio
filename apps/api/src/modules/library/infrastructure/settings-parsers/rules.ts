import {
  redactSettingsDocument,
  type SettingsRedactionOptions,
} from '../../domain/settings-redaction';
import { RulesSyntaxError, type RulesToken, tokenizeRules } from './starlark-tokens';
import type { SettingsParserResult } from './types';

export interface PermissionRulesSource {
  readonly name: string;
  readonly content: string;
}

/** Codex documents `allow` as the decision of a `prefix_rule` that omits one. */
const DEFAULT_DECISION = 'allow';

interface ParsedRule {
  /** 1-based line the call starts on; keeps field paths stable for one-line rules. */
  readonly line: number;
  readonly pattern: string;
  readonly decision: string;
}

type LiteralValue = string | readonly LiteralValue[];

/**
 * Reads Codex `.rules` files, which are Starlark: a rule is a `prefix_rule(...)`
 * call that may span any number of lines, with comments between arguments.
 *
 * A file this cannot interpret is reported as one parse failure rather than as
 * the rules it happened to understand: the permission comparison would otherwise
 * show "not configured" for rules that are in force.
 */
export function parsePermissionRules(
  sources: readonly PermissionRulesSource[],
  options: SettingsRedactionOptions
): SettingsParserResult {
  try {
    const fields = sources.flatMap((source) =>
      parseRulesFile(source.content).flatMap((rule) =>
        redactSettingsDocument(
          { pattern: rule.pattern, decision: rule.decision },
          { ...options, rootPath: `${source.name}[${rule.line}]` }
        )
      )
    );
    return { parsed: true, fields };
  } catch (error) {
    if (error instanceof RulesSyntaxError) {
      return { parsed: false, failureReason: 'invalid-rules', fields: [] };
    }
    throw error;
  }
}

function parseRulesFile(content: string): ParsedRule[] {
  const tokens = tokenizeRules(content);
  const rules: ParsedRule[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as RulesToken;
    if (token.kind === 'newline') {
      index += 1;
      continue;
    }

    const opening = tokens[index + 1];
    if (token.kind !== 'word' || opening?.kind !== 'punct' || opening.value !== '(') {
      throw new RulesSyntaxError('expected a call such as prefix_rule(...)', token.line);
    }
    const close = findClosingParen(tokens, index + 1);
    const args = tokens.slice(index + 2, close);

    if (token.value === 'prefix_rule') {
      rules.push(parsePrefixRule(args, token.line));
    } else if (token.value !== 'host_executable') {
      // Any other call may be a rule form this reader does not know.
      throw new RulesSyntaxError(`unsupported call '${token.value}'`, token.line);
    }

    index = close + 1;
    const following = tokens[index];
    if (following !== undefined && following.kind !== 'newline') {
      throw new RulesSyntaxError('expected a new line after the call', following.line);
    }
  }
  return rules;
}

/** Brackets are balanced (the tokenizer guarantees it), so a depth count finds the match. */
function findClosingParen(tokens: readonly RulesToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index] as RulesToken;
    if (token.kind !== 'punct') continue;
    if (isOpener(token.value)) depth += 1;
    else if (isCloser(token.value) && --depth === 0) return index;
  }
  throw new RulesSyntaxError(
    "')' expected to close the call",
    (tokens[openIndex] as RulesToken).line
  );
}

function parsePrefixRule(args: readonly RulesToken[], line: number): ParsedRule {
  let pattern: string | undefined;
  let decision = DEFAULT_DECISION;

  for (const argument of splitTopLevel(args)) {
    const name = argument[0];
    const equals = argument[1];
    if (name?.kind !== 'word' || equals?.kind !== 'punct' || equals.value !== '=') {
      throw new RulesSyntaxError('prefix_rule takes keyword arguments only', name?.line ?? line);
    }
    const value = argument.slice(2);
    // Other arguments (justification, match, not_match, ...) never change what a
    // rule allows or forbids, so they are skipped rather than required to parse.
    if (name.value === 'pattern') pattern = renderPattern(value, name.line);
    else if (name.value === 'decision') decision = parseDecision(value, name.line);
  }

  if (pattern === undefined) throw new RulesSyntaxError('prefix_rule has no pattern', line);
  return { line, pattern, decision };
}

function parseDecision(tokens: readonly RulesToken[], line: number): string {
  const only = tokens[0];
  if (tokens.length !== 1 || only?.kind !== 'string') {
    throw new RulesSyntaxError('decision must be a string literal', line);
  }
  return only.value;
}

/**
 * A pattern is a non-empty list of literal strings or lists of alternatives.
 * It is re-rendered rather than copied from the source, so the displayed value
 * does not depend on how the file was wrapped or indented.
 */
function renderPattern(tokens: readonly RulesToken[], line: number): string {
  const value = parseLiteral(tokens, line);
  if (typeof value === 'string' || value.length === 0) {
    throw new RulesSyntaxError('pattern must be a non-empty list', line);
  }
  const wellFormed = value.every(
    (element) =>
      typeof element === 'string' || element.every((alternative) => typeof alternative === 'string')
  );
  if (!wellFormed)
    throw new RulesSyntaxError('pattern elements must be strings or lists of strings', line);
  return renderLiteral(value);
}

function renderLiteral(value: LiteralValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return `[${value.map(renderLiteral).join(', ')}]`;
}

function parseLiteral(tokens: readonly RulesToken[], line: number): LiteralValue {
  const first = tokens[0];
  if (tokens.length === 1 && first?.kind === 'string') return first.value;

  const last = tokens.at(-1);
  if (
    first?.kind === 'punct' &&
    first.value === '[' &&
    last?.kind === 'punct' &&
    last.value === ']'
  ) {
    // A leading '[' and trailing ']' may belong to two different lists
    // (`["a"] + ["b"]`); splitting by depth rejects that instead of misreading it.
    const inner = tokens.slice(1, -1);
    if (isBalanced(inner))
      return splitTopLevel(inner).map((item) => parseLiteral(item, item[0]?.line ?? line));
  }
  throw new RulesSyntaxError('expected a string or list literal', first?.line ?? line);
}

/** Splits on commas outside brackets; one trailing comma is allowed, as in Starlark. */
function splitTopLevel(tokens: readonly RulesToken[]): RulesToken[][] {
  const parts: RulesToken[][] = [];
  let current: RulesToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (isOpener(token.value)) depth += 1;
      else if (isCloser(token.value)) depth -= 1;
      else if (token.value === ',' && depth === 0) {
        if (current.length === 0) throw new RulesSyntaxError('unexpected ","', token.line);
        parts.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function isBalanced(tokens: readonly RulesToken[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== 'punct') continue;
    if (isOpener(token.value)) depth += 1;
    else if (isCloser(token.value) && --depth < 0) return false;
  }
  return depth === 0;
}

function isOpener(value: string): boolean {
  return value === '(' || value === '[' || value === '{';
}

function isCloser(value: string): boolean {
  return value === ')' || value === ']' || value === '}';
}
