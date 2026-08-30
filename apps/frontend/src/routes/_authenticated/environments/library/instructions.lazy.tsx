import { createLazyFileRoute } from '@tanstack/react-router';
import { MatrixPage } from '@/features/library/components/MatrixPage';

export const Route = createLazyFileRoute('/_authenticated/environments/library/instructions')({
  component: () => <MatrixPage kind="instruction" />,
});
