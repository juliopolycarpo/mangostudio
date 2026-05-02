import type {
  RuleFilePreviewBody,
  RuleFilePreviewResponse,
} from '@mangostudio/shared/prompt-rules';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export async function previewRuleFile(body: RuleFilePreviewBody): Promise<RuleFilePreviewResponse> {
  const { data, error } = await client.api.settings['rule-files'].preview.post(body);
  if (error) throw new Error(extractApiError(error.value, 'Failed to preview rule file'));
  return data as RuleFilePreviewResponse;
}
