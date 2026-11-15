import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TechApi, type Ticket } from './api';
import { toast } from '@/components/ui';
import type { ApiError } from '@/lib/api';

export const techKeys = {
  myTickets: (status?: string) => ['tech', 'myTickets', status ?? 'all'] as const,
  ticket: (id: string) => ['tech', 'ticket', id] as const,
  history: (id: string) => ['tech', 'history', id] as const,
  myDevices: () => ['tech', 'myDevices'] as const,
  mySims: (technicianId?: string) => ['tech', 'mySims', technicianId ?? 'me'] as const,
};

export function useMyTickets(status?: string) {
  return useQuery({
    queryKey: techKeys.myTickets(status),
    queryFn: () => TechApi.myTickets(status ? { status } : undefined),
  });
}

export function useTicket(id: string) {
  return useQuery({
    queryKey: techKeys.ticket(id),
    queryFn: () => TechApi.ticket(id),
    enabled: !!id,
  });
}

export function useMyDevices() {
  return useQuery({ queryKey: techKeys.myDevices(), queryFn: () => TechApi.myDevices() });
}

export function useMySims(technicianId?: string) {
  return useQuery({
    queryKey: techKeys.mySims(technicianId),
    queryFn: () => TechApi.mySims(technicianId),
    enabled: !!technicianId,
  });
}

/** Generic ticket mutation helper: runs fn, invalidates ticket + list, toasts. */
export function useTicketMutation<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  opts?: { ticketId?: string; successMsg?: string; onDone?: () => void },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (opts?.ticketId) qc.invalidateQueries({ queryKey: techKeys.ticket(opts.ticketId) });
      qc.invalidateQueries({ queryKey: ['tech', 'myTickets'] });
      if (opts?.successMsg) toast.success(opts.successMsg);
      opts?.onDone?.();
    },
    onError: (e: ApiError) => toast.error(e?.message || 'Action failed'),
  });
}

export type { Ticket };
