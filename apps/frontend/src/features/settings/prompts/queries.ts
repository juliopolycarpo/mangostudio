import { queryOptions } from '@tanstack/react-query';
import type { RuleFileDescriptor } from '@mangostudio/shared/prompt-rules';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

export const ruleFileKeys = {
  all: ['rule-files'] as const,
  defaults: () => [...ruleFileKeys.all, 'defaults'] as const,
};

export interface DefaultRuleFilesResponse {
  files: RuleFileDescriptor[];
}

export function defaultRuleFilesQueryOptions() {
  return queryOptions({
    queryKey: ruleFileKeys.defaults(),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await client.api.settings['rule-files'].defaults.get();
      if (error) throw new Error(extractApiError(error.value, 'Failed to load rule files'));
      return data as DefaultRuleFilesResponse;
    },
  });
}
