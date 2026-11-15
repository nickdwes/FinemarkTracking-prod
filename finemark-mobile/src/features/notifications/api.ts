import { apiFetch } from '@/lib/api';

export interface AppNotification {
  id: string;
  type?: string;
  title?: string;
  body?: string;
  link?: string;
  read?: boolean;
  createdAt?: string;
}

export const NotificationsApi = {
  list: () => apiFetch<{ notifications: AppNotification[]; unread: number }>('/notifications'),
  markRead: (id: string) => apiFetch(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => apiFetch('/notifications/read-all', { method: 'PATCH' }),
};
