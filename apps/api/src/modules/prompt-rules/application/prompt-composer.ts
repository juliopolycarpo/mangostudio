import type {
  FixedRuleFileKind,
  PromptInjectionRole,
  PromptSendFrequency,
  PromptSettings,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';

import { loadFixedRuleFileContent, loadRuleFileContent } from './rule-file-resolver';

interface AppliedRuleFile {
  label: string;
  path: string;
  role: PromptInjectionRole;
}

export interface PromptCompositionResult {
  effectiveSystemPrompt: string;
  effectivePrompt: string;
  appliedRuleFiles: AppliedRuleFile[];
}

function ruleApplies(sendFrequency: PromptSendFrequency, isFirstTurn: boolean): boolean {
  if (sendFrequency === 'every-turn') return true;
  return isFirstTurn;
}

function buildRuleDelimiter(label: string, path: string, open: boolean): string {
  const tag = open ? 'mangostudio-rule-file' : '/mangostudio-rule-file';
  return `<${tag} label="${label}" path="${path}">`;
}

interface ApplicableRule {
  label: string;
  /** What the prompt and `appliedRuleFiles` show: the path as the user's setting names it. */
  path: string;
  injectionRole: PromptInjectionRole;
  /**
   * Set for a built-in file. Its content is read from the library registry's
   * location, never from the stored `path`, which is only a label that cannot
   * follow `CLAUDE_CONFIG_DIR`.
   */
  fixedKind?: FixedRuleFileKind;
}

function collectApplicableRules(
  settings: PromptSettings | undefined,
  isFirstTurn: boolean
): ApplicableRule[] {
  if (!settings) return [];

  const rules: ApplicableRule[] = [];
  const allRules: Array<{ rule: RuleFileSetting; fixedKind?: FixedRuleFileKind }> = [
    { rule: settings.agentsMd, fixedKind: 'agents' },
    { rule: settings.claudeMd, fixedKind: 'claude' },
    ...settings.customRules.map((rule) => ({ rule })),
  ];

  for (const { rule, fixedKind } of allRules) {
    if (!rule.enabled) continue;
    if (!ruleApplies(rule.sendFrequency, isFirstTurn)) continue;

    rules.push({
      label: rule.label,
      path: rule.path,
      injectionRole: rule.injectionRole,
      ...(fixedKind && { fixedKind }),
    });
  }

  return rules;
}

function loadApplicableRuleContent(rule: ApplicableRule): string | null {
  return rule.fixedKind ? loadFixedRuleFileContent(rule.fixedKind) : loadRuleFileContent(rule.path);
}

function composeSystemPrompt(
  baseSystemPrompt: string,
  rules: ApplicableRule[]
): { prompt: string; applied: AppliedRuleFile[] } {
  const applied: AppliedRuleFile[] = [];

  let result = baseSystemPrompt;
  for (const rule of rules) {
    if (rule.injectionRole !== 'system') continue;

    const content = loadApplicableRuleContent(rule);
    if (content === null) continue;

    result += `\n\n${buildRuleDelimiter(rule.label, rule.path, true)}\n${
      content
    }\n${buildRuleDelimiter(rule.label, rule.path, false)}`;

    applied.push({ label: rule.label, path: rule.path, role: 'system' });
  }

  return { prompt: result, applied };
}

function composeUserPrompt(
  visiblePrompt: string,
  rules: ApplicableRule[]
): { prompt: string; applied: AppliedRuleFile[] } {
  const applied: AppliedRuleFile[] = [];
  const parts: string[] = [];

  for (const rule of rules) {
    if (rule.injectionRole !== 'user') continue;

    const content = loadApplicableRuleContent(rule);
    if (content === null) continue;

    parts.push(
      `${buildRuleDelimiter(rule.label, rule.path, true)}\n${content}\n${buildRuleDelimiter(
        rule.label,
        rule.path,
        false
      )}`
    );

    applied.push({ label: rule.label, path: rule.path, role: 'user' });
  }

  if (parts.length === 0) {
    return { prompt: visiblePrompt, applied };
  }

  const wrapperOpen = '<mangostudio-rule-context>';
  const wrapperClose = '</mangostudio-rule-context>';
  const effectivePrompt = `${wrapperOpen}\n${parts.join('\n\n')}\n${wrapperClose}\n\n${visiblePrompt}`;

  return { prompt: effectivePrompt, applied };
}

export function composePrompt(input: {
  settings: PromptSettings | undefined;
  baseSystemPrompt: string;
  visiblePrompt: string;
  isFirstTurn: boolean;
}): PromptCompositionResult {
  const rules = collectApplicableRules(input.settings, input.isFirstTurn);

  const systemResult = composeSystemPrompt(input.baseSystemPrompt, rules);
  const userResult = composeUserPrompt(input.visiblePrompt, rules);

  return {
    effectiveSystemPrompt: systemResult.prompt,
    effectivePrompt: userResult.prompt,
    appliedRuleFiles: [...systemResult.applied, ...userResult.applied],
  };
}
