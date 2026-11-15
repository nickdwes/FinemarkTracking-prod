/**
 * Runtime configuration. API base can be overridden per build via the
 * EXPO_PUBLIC_API_BASE env var (e.g. a staging backend); defaults to prod.
 */
export const CONFIG = {
  API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE ?? 'https://portal.finemarktracking.co.ke/api',
  // Web origin (for opening existing web reports via the in-app browser bridge).
  WEB_ORIGIN: process.env.EXPO_PUBLIC_WEB_ORIGIN ?? 'https://portal.finemarktracking.co.ke',
  REQUEST_TIMEOUT_MS: 15000,
} as const;
