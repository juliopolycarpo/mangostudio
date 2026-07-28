import { createFileRoute } from '@tanstack/react-router';
import { MatrixPage } from '@/features/library/components/MatrixPage';
import { libraryResourcesQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/library/instructions')({
  loader: ({ context: { queryClient } }) =>
    queryClient.prefetchQuery(libraryResourcesQueryOptions('instruction')),
  component: () => <MatrixPage kind="instruction" />,
});
