import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { createFileRoute } from '@tanstack/react-router';
import { validateEnvironmentSearch } from '@/features/environments/use-environment-scope';
import {
  terminalAvailabilityQueryOptions,
  terminalSessionsQueryOptions,
} from '@/features/terminal/services/terminal-service';

export const Route = createFileRoute('/_authenticated/terminal')({
  validateSearch: validateEnvironmentSearch,
  loaderDeps: ({ search }) => ({ environmentId: search.environmentId ?? LOCAL_ENVIRONMENT_ID }),
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(terminalAvailabilityQueryOptions(deps.environmentId));
    void queryClient.prefetchQuery(terminalSessionsQueryOptions(deps.environmentId));
  },
});
