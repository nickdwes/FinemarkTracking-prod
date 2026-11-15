import { apiFetch } from '@/lib/api';

export interface ChangeRequest {
  id: string;
  vehicleId: string;
  registration?: string;
  make?: string;
  model?: string;
  changes?: Record<string, { from: any; to: any }>;
  requestedBy?: string;
  requestedAt?: string;
  status?: string;
  [k: string]: any;
}

export interface Proforma {
  id: string;
  proformaNo?: string;
  customerName?: string;
  totalAmount?: number;
  status?: string;
  createdByUserId?: string;
  createdByName?: string;
  createdAt?: string;
  [k: string]: any;
}

export const ApprovalsApi = {
  // Vehicle change requests
  vehicleChanges: (status = 'Pending') =>
    apiFetch<{ data: ChangeRequest[] }>(`/vehicles/change-requests?status=${encodeURIComponent(status)}`),
  approveVehicleChange: (id: string, notes?: string) =>
    apiFetch(`/vehicles/change-requests/${id}/approve`, { method: 'POST', body: { notes } }),
  rejectVehicleChange: (id: string, notes?: string) =>
    apiFetch(`/vehicles/change-requests/${id}/reject`, { method: 'POST', body: { notes } }),

  // Proforma approvals (finance maker-checker)
  proformas: (status = 'Pending Approval') =>
    apiFetch<{ data: Proforma[] }>(`/crm/proforma?status=${encodeURIComponent(status)}`),
  approveProforma: (id: string, body?: Record<string, any>) =>
    apiFetch(`/crm/proforma/${id}/approve`, { method: 'POST', body: body || {} }),
  rejectProforma: (id: string, reason?: string) =>
    apiFetch(`/crm/proforma/${id}/reject`, { method: 'POST', body: { rejectedReason: reason, reason } }),
};
