/**
 * Idle session timeout enforcement.
 *
 * Each login flow (password, OTP, Azure SSO) tags its refresh_tokens row with
 * login_method, and the configured idle window for that method is enforced on
 * every authenticated request: /me polling and normal API calls don't count as
 * activity — only an explicit /auth/heartbeat call (fired by real mouse/keyboard
 * activity client-side) refreshes last_activity_at. If a session goes idle past
 * its configured window, the refresh_tokens row is revoked and the caller must
 * sign in again.
 */
import { pgGet, pgRun } from "../db.js";

export type LoginMethod = "password" | "otp" | "azure";

interface SessionTimeoutSettings {
  password_idle_minutes: number;
  otp_idle_minutes: number;
  azure_idle_minutes: number;
  updated_at: string;
  updated_by: string;
}

const DEFAULTS: SessionTimeoutSettings = {
  password_idle_minutes: 30,
  otp_idle_minutes: 30,
  azure_idle_minutes: 30,
  updated_at: "",
  updated_by: "system",
};

let cache: SessionTimeoutSettings | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

export const getSessionTimeoutSettings = async (): Promise<SessionTimeoutSettings> => {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  const row = await pgGet<SessionTimeoutSettings>(
    "SELECT * FROM session_timeout_settings WHERE id = 1"
  );
  cache = row ?? { ...DEFAULTS };
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cache;
};

export const invalidateSessionTimeoutSettingsCache = () => {
  cache = null;
  cacheExpiresAt = 0;
};

export const getIdleMinutes = async (loginMethod: string | null | undefined): Promise<number> => {
  const settings = await getSessionTimeoutSettings();
  switch (loginMethod) {
    case "otp":
      return settings.otp_idle_minutes;
    case "azure":
      return settings.azure_idle_minutes;
    case "password":
    default:
      return settings.password_idle_minutes;
  }
};

/**
 * Returns true (and revokes the session) if the given refresh-token session
 * has been idle longer than the configured window for its login method.
 */
export const isSessionIdleExpired = async (session: {
  id: string;
  login_method: string | null;
  last_activity_at: string | null;
}): Promise<boolean> => {
  if (!session.last_activity_at) return false;
  const idleMinutes = await getIdleMinutes(session.login_method);
  if (!idleMinutes || idleMinutes <= 0) return false;
  const idleMs = Date.now() - new Date(session.last_activity_at).getTime();
  if (idleMs <= idleMinutes * 60_000) return false;
  await pgRun("DELETE FROM refresh_tokens WHERE id = ?", [session.id]);
  return true;
};

export const touchSessionActivity = async (sessionId: string): Promise<void> => {
  await pgRun("UPDATE refresh_tokens SET last_activity_at = ? WHERE id = ?", [
    new Date().toISOString(),
    sessionId,
  ]);
};
