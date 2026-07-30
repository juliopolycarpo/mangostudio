import { createFileRoute } from '@tanstack/react-router';
import { MatrixPage } from '@/features/library/components/MatrixPage';
import { libraryResourcesQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/subagents')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(libraryResourcesQueryOptions('subagent')),
  component: () => <MatrixPage kind="subagent" />,
});
