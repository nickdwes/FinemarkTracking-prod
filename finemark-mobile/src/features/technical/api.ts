import { apiFetch, uploadFile } from '@/lib/api';

/** Loose shapes — the backend camelCases via mapTicket; we read defensively. */
export interface Ticket {
  id: string;
  ticketNo?: string;
  status?: string;
  stage?: number;
  customerName?: string;
  vehicleRegistration?: string;
  vehicleId?: string;
  notes?: string;
  assignedToEmail?: string;
  assignedToName?: string;
  coTechnicianEmail?: string;
  isoEmail?: string;
  isoName?: string;
  statusReason?: string;
  statusEvidence?: { url: string; filename?: string }[];
  rescheduledTo?: string;
  activationRequestedAt?: string;
  activationApprovedAt?: string;
  // The backend (mapTicket in installation-tickets.ts) only ever returns the *At
  // timestamp fields below — there is no boolean `technicianSignedOff` /
  // `engineerSignedOff` field on the ticket. Treat a truthy timestamp as "signed off".
  technicianSignedOffAt?: string | null;
  engineerSignedOffAt?: string | null;
  jobCardPhotoUrl?: string | null;
  createdAt?: string;
  [k: string]: any;
}

export interface ListResp<T> {
  data: T[];
  meta?: Record<string, any>;
}

/** Mirrors CompletionBlocker in installation-tickets.ts — returned on a 422 COMPLETION_BLOCKED. */
export interface CompletionBlocker {
  code: string;
  message: string;
  devices?: any[];
}

/**
 * Normalize a list response. The backend's ok(res, data) helper returns the payload
 * BARE (a raw array) when no message is passed, but wraps it as { data } when a message
 * is present — so different endpoints answer with either shape. This coerces both a raw
 * array and a { data } / { data, meta } envelope into a stable { data: T[] }.
 */
async function asList<T = any>(p: Promise<any>): Promise<ListResp<T>> {
  const r = await p;
  if (Array.isArray(r)) return { data: r };
  return { data: r?.data ?? [], meta: r?.meta };
}

export const TechApi = {
  myTickets: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<ListResp<Ticket>>(`/installation-tickets/my${q}`);
  },
  ticket: (id: string) => apiFetch<{ data: Ticket }>(`/installation-tickets/${id}`),
  history: (id: string) => apiFetch<ListResp<any>>(`/installation-tickets/${id}/history`),

  updateStatus: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/status`, { method: 'PATCH', body }),
  saveStep: (id: string, stepKey: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/step/${stepKey}`, { method: 'PATCH', body }),
  lifecycle: (id: string, body: { action: string; reason?: string; evidence?: any[]; rescheduledTo?: string }) =>
    apiFetch(`/installation-tickets/${id}/lifecycle`, { method: 'POST', body }),

  acknowledge: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/acknowledge`, { method: 'POST', body }),
  travelStart: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/travel-start`, { method: 'POST', body }),
  arrived: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/arrived`, { method: 'POST', body }),
  notifyIso: (id: string, body?: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/notify-iso`, { method: 'POST', body: body || {} }),
  activationApprove: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/activation-approve`, { method: 'POST', body }),
  activationReject: (id: string, body: Record<string, any>) =>
    apiFetch(`/installation-tickets/${id}/activation-reject`, { method: 'POST', body }),

  upload: (id: string, file: { uri: string; name: string; type: string }) =>
    uploadFile(`/installation-tickets/${id}/upload`, file),

  // Custody — NB: these endpoints return a BARE array (ok() without a message),
  // so normalize through asList() to a { data } envelope the screens can read.
  myDevices: () => asList(apiFetch('/device-custody/my-devices')),
  availableForJob: (technicianId?: string) => {
    const q = technicianId ? `?technicianId=${encodeURIComponent(technicianId)}` : '';
    return asList(apiFetch(`/device-custody/available-for-job${q}`));
  },
  ackIssue: (issueId: string, body: { action: 'accept' | 'reject'; rejectionReason?: string }) =>
    apiFetch(`/device-custody/issue/${issueId}/acknowledge`, { method: 'POST', body }),
  assignToJob: (body: Record<string, any>) => apiFetch('/device-custody/assign-to-job', { method: 'POST', body }),
  returnDefective: (body: Record<string, any>) => apiFetch('/device-custody/return-defective', { method: 'POST', body }),

  // SIMs
  // Scope to the logged-in technician — WITHOUT technicianId this returns the
  // GLOBAL first page of issued SIMs (all technicians), not the user's custody.
  // The backend resolves technicianId through the same roster id-set as /my-devices.
  mySims: (technicianId?: string) => {
    const scope = technicianId ? `&technicianId=${encodeURIComponent(technicianId)}` : '';
    return asList(apiFetch(`/inventory/sims?status=issued&pageSize=500${scope}`));
  },
  ackSims: (body: { sim_ids: string[]; action: 'accept' | 'reject'; notes?: string }) =>
    apiFetch('/inventory/sims/acknowledge', { method: 'POST', body }),

  roster: () => apiFetch<{ data?: any }>('/technical-team/me'),
};
