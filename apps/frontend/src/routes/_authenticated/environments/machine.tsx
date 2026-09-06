import { createFileRoute } from '@tanstack/react-router';
import {
  machineDoctorQueryOptions,
  machineLogsQueryOptions,
  machineStatusQueryOptions,
  machineUpdateQueryOptions,
} from '@/features/environments/machine/queries';

export const Route = createFileRoute('/_authenticated/environments/machine')({
  loader: ({ context: { queryClient } }) => {
    // Prefetch, never `ensure`: each card renders its own pending state, so
    // navigation must not wait on the slowest of the four.
    void queryClient.prefetchQuery(machineStatusQueryOptions());
    void queryClient.prefetchQuery(machineDoctorQueryOptions());
    void queryClient.prefetchQuery(machineLogsQueryOptions());
    void queryClient.prefetchQuery(machineUpdateQueryOptions());
  },
});
