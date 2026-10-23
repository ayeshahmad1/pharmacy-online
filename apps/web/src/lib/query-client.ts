import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, errorMessage } from './api';

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: Error;
    /** Set `skipErrorToast` on a mutation that shows its own error inline. */
    mutationMeta: { skipErrorToast?: boolean };
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 4xx answers will not change on retry; network blips and 5xx might.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
        failureCount < 2,
    },
  },
  // Failed writes always tell the user something. Query errors are shown inline by each page.
  mutationCache: new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) => {
      if (!mutation.meta?.skipErrorToast) toast.error(errorMessage(error));
    },
  }),
});
