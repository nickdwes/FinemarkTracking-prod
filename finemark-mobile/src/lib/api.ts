/**
 * API client — a faithful port of the web portal's apiFetch (finemark-ui/assets/app.js:1308).
 *
 * - Attaches `Authorization: Bearer <accessToken>`.
 * - On 401 while a refresh token exists → POST /auth/refresh (single-flight), persist the
 *   rotated tokens, retry the original request once.
 * - On refresh failure → clear the session and notify the app to route to login.
 * - Normalizes the backend `{ error: { code, message, details } }` shape.
 * - 15s timeout; retries transient [0,502,503,504].
 */
import { CONFIG } from '@/constants/config';
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  saveRefreshToken,
  saveMeta,
} from '@/lib/session';

export interface ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
}

export function apiError(status: number, code: string, message: string, details?: unknown): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  e.code = code;
  e.details = details;
  e.name = 'ApiError';
  return e;
}

// The app registers a handler so a hard session-expiry can bounce to the login screen.
let sessionExpiredHandler: ((reason: string) => void) | null = null;
export function onSessionExpired(fn: (reason: string) => void): void {
  sessionExpiredHandler = fn;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  retry?: { retries: number; delayMs: number };
  signal?: AbortSignal;
  /** Skip auth header + refresh (used by the login/refresh calls themselves). */
  auth?: boolean;
}

// Single-flight refresh: parallel 401s share one refresh round-trip.
let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${CONFIG.API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const code = payload?.error?.code || payload?.code || 'UNAUTHORIZED';
        await clearSession();
        sessionExpiredHandler?.(code === 'IDLE_TIMEOUT' ? 'idle_timeout' : 'session_expired');
        return false;
      }
      const data = await res.json();
      setAccessToken(data.accessToken);
      if (data.refreshToken) await saveRefreshToken(data.refreshToken);
      await saveMeta({ idleTimeoutMinutes: data.idleTimeoutMinutes, loginMethod: data.loginMethod });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function normalize(err: unknown): ApiError {
  if (err && typeof err === 'object' && 'code' in err && 'status' in err) return err as ApiError;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return apiError(0, 'TIMEOUT', 'Request timed out');
    return apiError(0, 'NETWORK', err.message || 'Network error');
  }
  return apiError(0, 'ERROR', 'Request failed');
}

const transient = (status: number) => [0, 502, 503, 504].includes(status);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function apiFetch<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const useAuth = options.auth !== false;
  const retryCfg = options.retry || { retries: 0, delayMs: 0 };

  const buildHeaders = (): Record<string, string> => {
    const token = getAccessToken();
    return {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      ...(useAuth && token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const once = async (): Promise<{ status: number; payload: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
        method,
        headers: buildHeaders(),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal ?? controller.signal,
      });
      const payload = await res.json().catch(() => ({}));
      return { status: res.status, payload };
    } finally {
      clearTimeout(timeout);
    }
  };

  let attempt = 0;
  // +1 extra pass reserved for the post-refresh retry.
  while (attempt <= (retryCfg.retries || 0)) {
    try {
      let { status, payload } = await once();

      if (status === 401 && useAuth) {
        const refreshed = await doRefresh();
        if (refreshed) {
          ({ status, payload } = await once());
        }
      }

      if (status < 200 || status >= 300) {
        const code = payload?.error?.code || payload?.code || 'ERROR';
        const message = payload?.error?.message || payload?.message || 'Request failed';
        throw apiError(status, code, message, payload?.error?.details || payload?.details);
      }
      return payload as T;
    } catch (e) {
      const err = normalize(e);
      if (err.code === 'FORBIDDEN' && String(err.message).toLowerCase().includes('disabled')) {
        await clearSession();
        sessionExpiredHandler?.('disabled');
      }
      if (attempt < (retryCfg.retries || 0) && transient(err.status)) {
        await wait(retryCfg.delayMs || 500);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  throw apiError(0, 'ERROR', 'Request failed');
}

/**
 * Multipart upload (job-card evidence photos, etc.). Field name is `file`, matching
 * installation-tickets.ts:2098. React Native's fetch accepts { uri, name, type } parts.
 */
export async function uploadFile(
  path: string,
  file: { uri: string; name: string; type: string },
  extra?: Record<string, string>,
): Promise<any> {
  const form = new FormData();
  // @ts-expect-error RN FormData accepts the { uri, name, type } shape.
  form.append('file', { uri: file.uri, name: file.name, type: file.type });
  if (extra) Object.entries(extra).forEach(([k, v]) => form.append(k, v));

  const send = async (): Promise<{ status: number; payload: any }> => {
    const token = getAccessToken();
    const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, // no Content-Type: let RN set the boundary
      body: form,
    });
    const payload = await res.json().catch(() => ({}));
    return { status: res.status, payload };
  };

  let { status, payload } = await send();
  if (status === 401) {
    if (await doRefresh()) ({ status, payload } = await send());
  }
  if (status < 200 || status >= 300) {
    throw apiError(
      status,
      payload?.error?.code || 'UPLOAD_FAILED',
      payload?.error?.message || 'Upload failed',
      payload?.error?.details,
    );
  }
  return payload;
}

/** Absolute URL for a server-relative upload path (still needs the Bearer token to fetch). */
export function fileUrl(relative?: string | null): string | null {
  if (!relative) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  return `${CONFIG.WEB_ORIGIN}${relative.startsWith('/') ? '' : '/'}${relative}`;
}
