import { apiFetch } from '@/lib/api';

export interface Lead {
  id: string;
  leadNo?: string;
  customerName?: string;
  customerPhone?: string;
  phone?: string;
  status?: string;
  leadSource?: string;
  segment?: string;
  createdAt?: string;
  submittedAt?: string;
  [k: string]: any;
}

export interface Customer {
  id: string;
  name?: string;
  displayName?: string;
  type?: string;
  region?: string;
  phone?: string;
  createdAt?: string;
  [k: string]: any;
}

export const SalesApi = {
  // Retail leads — NB: this endpoint returns { leads }, not { data }.
  retailLeads: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<{ leads: Lead[]; data?: Lead[]; meta?: any }>(`/retail/leads${q}`);
  },
  createRetailLead: (body: Record<string, any>) => apiFetch('/retail/leads', { method: 'POST', body }),
  retailLead: (id: string) => apiFetch<{ lead: any }>(`/retail/leads/${id}`),

  // Corporate leads
  corporateLeads: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<{ data: Lead[]; meta?: any }>(`/crm/leads${q}`);
  },
  createCorporateLead: (body: Record<string, any>) => apiFetch('/crm/leads', { method: 'POST', body }),
  corporateLead: (id: string) => apiFetch<{ data: any }>(`/crm/leads/${id}`),

  // Customers
  customers: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<{ data: Customer[]; meta?: any }>(`/crm/customers${q}`);
  },
  customer360: (id: string) => apiFetch<any>(`/crm/customers/${id}/360`),
  customerStats: () => apiFetch<{ total: number; individual: number; corporate: number; active: number; subscriptionsExpiringSoon: number }>('/crm/customers/stats/summary'),
  leadStats: () => apiFetch<{ stats: Record<string, number> }>('/retail/leads/stats'),
  teamPerformance: () => apiFetch<{ data: any[]; totals: { reps: number; leads: number; completed: number; pipeline: number; accepted: number }; currency: string; scope: string }>('/sales-intelligence/team-performance'),
  pipelineValue: () => apiFetch<{ quotedValue: number; invoicedValue: number; pipelineValue: number; currency: string }>('/retail/leads/pipeline-value'),
  registerCustomer: (body: Record<string, any>) => apiFetch('/crm/customers/register', { method: 'POST', body }),

  // Vehicles
  createVehicle: (body: Record<string, any>) => apiFetch('/vehicles', { method: 'POST', body }),
  checkVehicleDuplicate: (registration: string) =>
    apiFetch(`/vehicles/check-duplicate?registration=${encodeURIComponent(registration)}`),

  // ── Dropdown data sources (mirror retail-lead-new.html) ──────────────────
  // Backend requires locationName in this request body (it isn't persisted on the
  // lead row, so it can never be reconstructed server-side) — always forward the
  // location fields the caller already has on screen. Was previously duplicated
  // as `submitRetailLead` with a hardcoded empty body; consolidated to this one.
  submitRetail: (id: string, body?: { locationName?: string; locationNotes?: string | null }) =>
    apiFetch(`/retail/leads/${id}/submit`, { method: 'POST', body: body || {} }),

  // Manual catch-up for a retail lead that hasn't been auto-quoted yet (private/
  // non-partner leads, or a partner lead whose device-assignment automation
  // hasn't fired) — mirrors retail-lead-detail.html's "Raise & Edit Quote".
  // Backend's created() wraps the payload as {data, message} whenever a message
  // is passed (it always is here) — unlike most other create endpoints in this
  // file that omit the message and return the payload unwrapped at the top level.
  raiseQuote: (leadId: string) =>
    apiFetch<{ data: { quoteId: string; quoteNo: string; pricingMissing: boolean }; message?: string }>(`/retail/leads/${leadId}/raise-quote`, { method: 'POST', body: {} }),

  partners: () => apiFetch<{ data: any[] }>('/partners?pageSize=200'),

  catalogCategories: () => apiFetch<{ data: any[] }>('/inventory/catalog/categories'),
  catalogProducts: () => apiFetch<{ data: any[] }>('/inventory/catalog?pageSize=500'),

  vehicleMakes: (category?: string) => {
    const qs = category ? `?category=${encodeURIComponent(category)}` : '';
    return apiFetch<{ data: string[] }>(`/vehicle-master/catalog/makes${qs}`);
  },
  vehicleModels: (make: string, category?: string) => {
    const cat = category ? `&category=${encodeURIComponent(category)}` : '';
    return apiFetch<{ data: { model: string; bodyStyle?: string }[] }>(
      `/vehicle-master/catalog/models?make=${encodeURIComponent(make)}${cat}`,
    );
  },

  // Typeahead search — matches customer name, phone number, or vehicle registration
  // (backend /by-phone decrypt-scans phone and joins vehicle plates).
  searchCustomers: (q: string) =>
    apiFetch<{ data: any[] }>(`/crm/customers/by-phone?q=${encodeURIComponent(q)}`),

  // Quotations (crm_quotes)
  quotes: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<{ data: any[]; meta?: any }>(`/crm/quotes${q}`);
  },
  quote: (id: string) => apiFetch<{ data: any }>(`/crm/quotes/${id}`),
  updateQuote: (id: string, body: Record<string, any>) => apiFetch(`/crm/quotes/${id}`, { method: 'PATCH', body }),
  sendQuote: (id: string, toEmail: string) => apiFetch(`/crm/quotes/${id}/send`, { method: 'POST', body: { toEmail } }),
  // Marks a Draft quote Sent without emailing it (mirrors web's ensureQuoteMarkedSent /
  // "Send to Customer" flow when no toEmail is given — POST /:id/send is a no-op on an
  // already-Sent quote and 409s on any other status).
  markQuoteSent: (id: string) => apiFetch(`/crm/quotes/${id}/send`, { method: 'POST', body: {} }),
  acceptQuote: (id: string) => apiFetch(`/crm/quotes/${id}/accept`, { method: 'POST' }),
  rejectQuote: (id: string, reason?: string) => apiFetch(`/crm/quotes/${id}/reject`, { method: 'POST', body: { reason: reason || null } }),
};

export const LEAD_SOURCES = ['Direct', 'Referral', 'Bank Partnership', 'Car Yard', 'Walk-in', 'Digital', 'Telesales'];
// 'bank partnership' intentionally omitted — crm-leads.ts requires a partnerId whenever
// this source is chosen, and there's no partner-picker UI wired into the corporate form
// yet. Re-add once a partner picker ships (see CorporateLeadForm.tsx).
export const CORPORATE_SOURCES = ['Direct', 'Referral', 'Tender', 'Digital'];
