import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * React Query client. Cached data is persisted to AsyncStorage so screens (job lists,
 * custody, leads) render instantly offline and refetch on reconnect. Mutations that fail
 * offline are paused and resumed by the offline queue (see lib/offlineQueue.ts).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24, // keep for a day for offline use
      retry: 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

export const asyncPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'FINEMARK_QUERY_CACHE',
  throttleTime: 1000,
});
