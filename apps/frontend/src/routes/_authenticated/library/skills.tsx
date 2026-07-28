import { createFileRoute } from '@tanstack/react-router';
import { MatrixPage } from '@/features/library/components/MatrixPage';
import { libraryResourcesQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/library/skills')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(libraryResourcesQueryOptions('skill')),
  component: () => <MatrixPage kind="skill" />,
});
