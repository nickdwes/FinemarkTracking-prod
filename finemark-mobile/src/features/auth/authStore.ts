import { create } from 'zustand';
import type { SessionUser } from '@/constants/roles';
import { CONFIG } from '@/constants/config';
import {
  clearSession,
  getRefreshToken,
  getSavedUser,
  isBiometricEnabled,
  persistSession,
  setAccessToken,
  setBiometricEnabled as persistBiometricPref,
} from '@/lib/session';
import { onSessionExpired } from '@/lib/api';
import {
  loginWithPassword,
  verifyOtp,
  requestOtp,
  logoutServer,
  fetchMe,
} from '@/features/auth/authApi';
import { getBiometricCapability, promptBiometric } from '@/features/auth/biometrics';

export type AuthStatus = 'loading' | 'unauthenticated' | 'locked' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  notice: string | null; // e.g. "session_expired" / "idle_timeout" / "disabled"
  biometricEnabled: boolean;
  biometricLabel: string;

  bootstrap: () => Promise<void>;
  signInPassword: (email: string, password: string) => Promise<void>;
  sendOtp: (email: string) => Promise<void>;
  signInOtp: (email: string, code: string) => Promise<void>;
  unlockWithBiometric: () => Promise<boolean>;
  useDifferentAccount: () => Promise<void>;
  enableBiometric: (on: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  clearNotice: () => void;
}

/** Call POST /auth/refresh directly and set the in-memory access token. */
async function refreshUsingStoredToken(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${CONFIG.API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    await persistSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      idleTimeoutMinutes: data.idleTimeoutMinutes,
      loginMethod: data.loginMethod,
    });
    return true;
  } catch {
    return false;
  }
}

function extractUser(me: any, fallback: SessionUser | null): SessionUser | null {
  const u = me?.data ?? me;
  if (u && u.email) return u as SessionUser;
  return fallback;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  notice: null,
  biometricEnabled: false,
  biometricLabel: 'Biometrics',

  bootstrap: async () => {
    // Register the hard-expiry handler once.
    onSessionExpired((reason) => {
      setAccessToken(null);
      set({ status: 'unauthenticated', user: null, notice: reason });
    });

    const cap = await getBiometricCapability();
    const bioPref = await isBiometricEnabled();
    set({ biometricLabel: cap.label, biometricEnabled: bioPref && cap.available && cap.enrolled });

    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      set({ status: 'unauthenticated' });
      return;
    }

    const savedUser = await getSavedUser();

    // If biometric unlock is enabled + usable, gate re-entry behind it.
    if (bioPref && cap.available && cap.enrolled) {
      set({ status: 'locked', user: savedUser });
      return;
    }

    // Otherwise silently refresh straight into the app.
    const ok = await refreshUsingStoredToken();
    if (!ok) {
      await clearSession();
      set({ status: 'unauthenticated', user: null });
      return;
    }
    set({ status: 'authenticated', user: savedUser });
  },

  signInPassword: async (email, password) => {
    const bundle = await loginWithPassword(email.trim(), password);
    await persistSession(bundle);
    set({ status: 'authenticated', user: bundle.user, notice: null });
  },

  sendOtp: async (email) => {
    await requestOtp(email.trim());
  },

  signInOtp: async (email, code) => {
    const bundle = await verifyOtp(email.trim(), code.trim());
    await persistSession(bundle);
    set({ status: 'authenticated', user: bundle.user, notice: null });
  },

  unlockWithBiometric: async () => {
    const ok = await promptBiometric('Unlock Finemark');
    if (!ok) return false;
    const refreshed = await refreshUsingStoredToken();
    if (!refreshed) {
      // Stored refresh token no longer valid → force password login.
      await clearSession();
      set({ status: 'unauthenticated', user: null, notice: 'session_expired' });
      return false;
    }
    let user = get().user;
    try {
      user = extractUser(await fetchMe(), user);
    } catch {
      /* keep cached user */
    }
    set({ status: 'authenticated', user, notice: null });
    return true;
  },

  useDifferentAccount: async () => {
    await clearSession();
    set({ status: 'unauthenticated', user: null, notice: null });
  },

  enableBiometric: async (on) => {
    if (on) {
      const cap = await getBiometricCapability();
      if (!cap.available || !cap.enrolled) return;
      const ok = await promptBiometric(`Enable ${cap.label} unlock`);
      if (!ok) return;
    }
    await persistBiometricPref(on);
    set({ biometricEnabled: on });
  },

  signOut: async () => {
    await logoutServer();
    await clearSession();
    set({ status: 'unauthenticated', user: null, notice: null });
  },

  clearNotice: () => set({ notice: null }),
}));
