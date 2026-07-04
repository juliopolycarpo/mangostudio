import type { Messages } from '@mangostudio/shared/i18n';

type ConnectorMessages = Messages['settings']['connectors'];

/** Human-readable ChatGPT plan label, falling back to the raw value for unknown plans. */
export function formatPlan(planType: string | null | undefined, s: ConnectorMessages): string {
  const normalizedPlanType = planType?.toLowerCase() ?? '';
  switch (normalizedPlanType) {
    case 'plus':
      return s.chatgptPlanPlus;
    case 'pro':
      return s.chatgptPlanPro;
    case 'team':
      return s.chatgptPlanTeam;
    case 'free':
      return s.chatgptPlanFree;
    case '':
      return s.chatgptPlanUnknown;
    default:
      return s.chatgptPlanCustom.replace('{plan}', planType ?? normalizedPlanType);
  }
}
