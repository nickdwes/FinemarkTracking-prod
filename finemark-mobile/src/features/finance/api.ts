import { apiFetch } from '@/lib/api';

export interface Invoice {
  id: string;
  invoiceNo?: string;
  number?: string;
  customerName?: string;
  total?: number;
  totalAmount?: number;
  amountPaid?: number;
  balance?: number;
  status?: string;
  dueDate?: string;
  createdAt?: string;
  [k: string]: any;
}

export interface FinanceSummary {
  totalRevenue?: number;
  outstanding?: number;
  thisMonthRevenue?: number;
  avgPaymentDays?: number;
  currency?: string;
}

export const FinanceApi = {
  summary: () => apiFetch<FinanceSummary>('/finance/summary'),
  invoices: (params?: Record<string, string>) => {
    const q = params ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch<{ data: Invoice[]; meta?: any }>(`/invoices${q}`);
  },
  invoice: (id: string) => apiFetch<{ data: Invoice }>(`/invoices/${id}`),
  recordPayment: (body: Record<string, any>) => apiFetch('/payments', { method: 'POST', body }),
};

export const PAYMENT_METHODS = ['M-Pesa', 'Bank Transfer', 'Cheque', 'Cash', 'Card'];
