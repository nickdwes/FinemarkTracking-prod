/**
 * Session persistence.
 *
 * - The refresh token is the sensitive long-lived credential → stored in the device
 *   keychain/keystore via expo-secure-store (NEVER AsyncStorage).
 * - The access token is short-lived; kept in memory only (module-level).
 * - The non-sensitive user profile is cached (SecureStore too, for simplicity) so the
 *   UI can render instantly on relaunch before the silent refresh completes.
 */
import * as SecureStore from 'expo-secure-store';
import type { SessionUser } from '@/constants/roles';

const K_REFRESH = 'fm_refresh_token';
const K_USER = 'fm_user';
const K_META = 'fm_session_meta';
const K_BIOMETRIC = 'fm_biometric_enabled';

export interface SessionMeta {
  idleTimeoutMinutes?: number;
  loginMethod?: string;
}

// In-memory access token — deliberately not persisted.
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(K_REFRESH, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(K_REFRESH);
}

export async function saveUser(user: SessionUser): Promise<void> {
  await SecureStore.setItemAsync(K_USER, JSON.stringify(user));
}
export async function getSavedUser(): Promise<SessionUser | null> {
  const raw = await SecureStore.getItemAsync(K_USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function saveMeta(meta: SessionMeta): Promise<void> {
  await SecureStore.setItemAsync(K_META, JSON.stringify(meta));
}
export async function getMeta(): Promise<SessionMeta | null> {
  const raw = await SecureStore.getItemAsync(K_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

export async function setBiometricEnabled(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(K_BIOMETRIC, on ? '1' : '0');
}
export async function isBiometricEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(K_BIOMETRIC)) === '1';
}

/** Persist a full login/refresh bundle. */
export async function persistSession(bundle: {
  accessToken: string;
  refreshToken?: string;
  user?: SessionUser;
  idleTimeoutMinutes?: number;
  loginMethod?: string;
}): Promise<void> {
  setAccessToken(bundle.accessToken);
  if (bundle.refreshToken) await saveRefreshToken(bundle.refreshToken);
  if (bundle.user) await saveUser(bundle.user);
  await saveMeta({ idleTimeoutMinutes: bundle.idleTimeoutMinutes, loginMethod: bundle.loginMethod });
}

/** Wipe everything (logout / disabled account / refresh failure). */
export async function clearSession(): Promise<void> {
  setAccessToken(null);
  await Promise.all([
    SecureStore.deleteItemAsync(K_REFRESH),
    SecureStore.deleteItemAsync(K_USER),
    SecureStore.deleteItemAsync(K_META),
    // Keep the biometric-enabled preference so the toggle survives, but it's harmless to keep.
  ]);
}
