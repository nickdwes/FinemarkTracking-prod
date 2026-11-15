import { apiFetch } from '@/lib/api';
import type { SessionUser } from '@/constants/roles';

export interface LoginBundle {
  accessToken: string;
  refreshToken: string;
  idleTimeoutMinutes?: number;
  loginMethod?: string;
  user: SessionUser;
}

export function loginWithPassword(email: string, password: string): Promise<LoginBundle> {
  return apiFetch<LoginBundle>('/auth/login', { method: 'POST', body: { email, password }, auth: false });
}

export function requestOtp(email: string): Promise<{ message?: string }> {
  return apiFetch('/auth/otp/request', { method: 'POST', body: { email }, auth: false });
}

export function verifyOtp(email: string, code: string): Promise<LoginBundle> {
  return apiFetch<LoginBundle>('/auth/otp/verify', { method: 'POST', body: { email, code }, auth: false });
}

export function logoutServer(): Promise<unknown> {
  return apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
}

export function heartbeat(): Promise<unknown> {
  return apiFetch('/auth/heartbeat', { method: 'POST' }).catch(() => undefined);
}

export function fetchMe(): Promise<{ data?: SessionUser } | SessionUser> {
  return apiFetch('/me', { method: 'GET' });
}
