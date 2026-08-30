import { createFileRoute } from '@tanstack/react-router';
import { skillSettingsListQueryOptions } from '@/features/settings/skills/queries';

export const Route = createFileRoute('/_authenticated/settings/skills')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(skillSettingsListQueryOptions()),
});
