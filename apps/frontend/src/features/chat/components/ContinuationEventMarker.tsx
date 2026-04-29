import type { ContinuationReasonCode, ProviderType } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';

interface ContinuationEventMarkerProps {
  provider: ProviderType;
  modelName: string;
  fromProvider?: ProviderType;
  fromMode: string;
  toMode: string;
  reasonCode: ContinuationReasonCode;
  recovered: boolean;
}

function resolveTitleTemplate(
  reasonCode: ContinuationReasonCode,
  t: ReturnType<typeof useI18n>['t']
): string {
  const titles = t.chat.continuation.title;
  switch (reasonCode) {
    case 'provider_changed':
      return titles.providerChanged;
    case 'model_changed':
      return titles.modelChanged;
    case 'system_prompt_changed':
      return titles.systemPromptChanged;
    case 'toolset_changed':
      return titles.toolsetChanged;
    case 'cursor_expired':
      return titles.cursorExpired;
    case 'cursor_invalid':
      return titles.cursorInvalid;
    case 'tool_result_cursor_loss':
      return titles.toolResultCursorLoss;
    case 'envelope_malformed':
      return titles.envelopeMalformed;
  }
}

function applyTemplateVars(
  template: string,
  vars: {
    provider: string;
    model: string;
    fromProvider: string;
    fromMode: string;
    toMode: string;
  }
): string {
  return template
    .replace(/{provider}/g, vars.provider)
    .replace(/{model}/g, vars.model)
    .replace(/{fromProvider}/g, vars.fromProvider)
    .replace(/{fromMode}/g, vars.fromMode)
    .replace(/{toMode}/g, vars.toMode);
}

const isError = (reasonCode: ContinuationReasonCode): boolean =>
  reasonCode === 'tool_result_cursor_loss';

export function ContinuationEventMarker({
  provider,
  modelName,
  fromProvider,
  fromMode,
  toMode,
  reasonCode,
  recovered,
}: ContinuationEventMarkerProps) {
  const { t } = useI18n();
  const template = resolveTitleTemplate(reasonCode, t);
  const label = applyTemplateVars(template, {
    provider,
    model: modelName,
    fromProvider: fromProvider ?? provider,
    fromMode,
    toMode,
  });
  const suffix = recovered ? t.chat.continuation.recovered : t.chat.continuation.notRecovered;

  const errorEvent = isError(reasonCode);
  const toneClass = errorEvent ? 'text-error/80' : 'text-on-surface-variant/60';
  const lineClass = errorEvent ? 'bg-error/30' : 'bg-outline-variant/20';

  return (
    <div className={`flex items-center gap-2 py-2 text-xs my-1 ${toneClass}`}>
      <div className={`flex-1 h-px ${lineClass}`} />
      <span className="font-medium whitespace-nowrap">
        {label} {suffix}
      </span>
      <div className={`flex-1 h-px ${lineClass}`} />
    </div>
  );
}
