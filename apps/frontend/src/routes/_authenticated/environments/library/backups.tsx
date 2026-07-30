import { createFileRoute } from '@tanstack/react-router';
import { BackupList } from '@/features/library/components/BackupList';
import { backupUsageQueryOptions } from '@/features/library/queries';

export const Route = createFileRoute('/_authenticated/environments/library/backups')({
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery(backupUsageQueryOptions()),
  component: BackupList,
});
