import { createLazyFileRoute } from '@tanstack/react-router';
import { BackupList } from '@/features/library/components/BackupList';

export const Route = createLazyFileRoute('/_authenticated/environments/library/backups')({
  component: BackupList,
});
