import React, { useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  Screen, GlassCard, Txt, Pill, NeonButton, SegmentedTabs, Loading, EmptyState, ErrorState, Sheet, Field, Divider, toast,
} from '@/components/ui';
import { ApprovalsApi, type ChangeRequest, type Proforma } from '@/features/approvals/api';
import { fmtDate, fmtKES } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { colors, spacing } from '@/theme';
import { useAuth } from '@/features/auth/authStore';
import { baseRole, VEHICLE_CHANGE_APPROVER_ROLES, PROFORMA_APPROVER_ROLES } from '@/constants/roles';

const FIELD_LABELS: Record<string, string> = {
  make: 'Make', model: 'Model', registration: 'Registration', color: 'Colour', vin: 'VIN',
  chassis_number: 'Chassis No', engine_number: 'Engine No', year_of_manufacture: 'Year',
  fuel_type: 'Fuel', transmission: 'Transmission', odometer: 'Odometer', insurance_expiry: 'Insurance Expiry',
  ntsa_status: 'NTSA', fleet_number: 'Fleet No', asset_code: 'Asset Code', trim: 'Trim',
};
const lbl = (k: string) => FIELD_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function ApprovalsScreen() {
  const user = useAuth((s) => s.user);
  const r = baseRole(user);
  // Each sub-tab hits a different backend endpoint with its own role gate (vehicle
  // changes = Admin only; proformas = Admin/Finance/BDM/BDMCorporate) — only show
  // (and default to) a segment the current role can actually load, so e.g. Finance
  // doesn't land on a "Vehicle changes" tab that 403s before they ever see the
  // Proformas tab they do have access to.
  const canVehicle = VEHICLE_CHANGE_APPROVER_ROLES.includes(r);
  const canProforma = PROFORMA_APPROVER_ROLES.includes(r);
  const segments = [
    ...(canVehicle ? [{ key: 'vehicle', label: 'Vehicle changes' }] : []),
    ...(canProforma ? [{ key: 'proforma', label: 'Proformas' }] : []),
  ];
  const [seg, setSeg] = useState<'vehicle' | 'proforma'>(canVehicle ? 'vehicle' : 'proforma');

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Txt variant="title">Approvals</Txt>
        {segments.length > 1 ? (
          <SegmentedTabs segments={segments} active={seg} onChange={(k) => setSeg(k as any)} />
        ) : null}
      </View>
      {seg === 'vehicle' && canVehicle ? <VehicleChanges /> : canProforma ? <Proformas /> : (
        <EmptyState icon="shield-checkmark-outline" title="Nothing to approve" subtitle="You don't have any pending approvals to review." />
      )}
    </Screen>
  );
}

function VehicleChanges() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['approvals', 'vehicle'], queryFn: () => ApprovalsApi.vehicleChanges('Pending') });
  const [rejecting, setRejecting] = useState<ChangeRequest | null>(null);
  const [notes, setNotes] = useState('');

  const done = () => qc.invalidateQueries({ queryKey: ['approvals', 'vehicle'] });
  const approve = useMutation({
    mutationFn: (id: string) => ApprovalsApi.approveVehicleChange(id),
    onSuccess: () => { toast.success('Change approved & applied'); done(); },
    onError: (e: ApiError) => toast.error(e?.message || 'Failed'),
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; notes: string }) => ApprovalsApi.rejectVehicleChange(v.id, v.notes),
    onSuccess: () => { toast.success('Change rejected'); setRejecting(null); setNotes(''); done(); },
    onError: (e: ApiError) => toast.error(e?.message || 'Failed'),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState message="Could not load requests" onRetry={q.refetch} />;
  const rows = q.data?.data ?? [];

  return (
    <>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.length === 0 ? (
          <EmptyState icon="shield-checkmark-outline" title="Nothing to review" subtitle="Vehicle-change requests will appear here." />
        ) : (
          rows.map((r) => (
            <GlassCard key={r.id}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Txt variant="heading">{r.registration || [r.make, r.model].filter(Boolean).join(' ') || 'Vehicle'}</Txt>
                  <Txt variant="faint">Requested by {r.requestedBy || '—'} · {fmtDate(r.requestedAt)}</Txt>
                </View>
                <Pill label="Pending" />
              </View>
              <Divider spacer={spacing.sm} />
              {Object.entries(r.changes || {}).map(([k, c]) => (
                <View key={k} style={styles.diffRow}>
                  <Txt variant="muted" style={{ flex: 1 }}>{lbl(k)}</Txt>
                  <Txt variant="faint" style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>{fmtVal(c.from)}</Txt>
                  <Arrow />
                  <Txt variant="body" weight="semibold" style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>{fmtVal(c.to)}</Txt>
                </View>
              ))}
              <View style={styles.cardActions}>
                <NeonButton label="Approve & apply" icon="checkmark" loading={approve.isPending} onPress={() => approve.mutate(r.id)} style={{ flex: 1 }} />
                <NeonButton label="Reject" variant="ghost" full={false} onPress={() => setRejecting(r)} style={{ flex: 1 }} />
              </View>
            </GlassCard>
          ))
        )}
      </ScrollView>

      <Sheet visible={!!rejecting} onClose={() => setRejecting(null)} title="Reject change">
        <Field label="Reason (optional)" placeholder="Why is this rejected?" value={notes} onChangeText={setNotes} multiline
          numberOfLines={3} style={{ minHeight: 84, textAlignVertical: 'top' }} />
        <NeonButton label="Reject change" variant="danger" loading={reject.isPending}
          onPress={() => rejecting && reject.mutate({ id: rejecting.id, notes })} />
      </Sheet>
    </>
  );
}

function Proformas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['approvals', 'proforma'], queryFn: () => ApprovalsApi.proformas('Pending Approval') });
  const [rejecting, setRejecting] = useState<Proforma | null>(null);
  const [reason, setReason] = useState('');

  const done = () => qc.invalidateQueries({ queryKey: ['approvals', 'proforma'] });
  const approve = useMutation({
    mutationFn: (id: string) => ApprovalsApi.approveProforma(id),
    onSuccess: () => { toast.success('Proforma approved'); done(); },
    onError: (e: ApiError) => toast.error(makerCheckerMsg(e)),
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; reason: string }) => ApprovalsApi.rejectProforma(v.id, v.reason),
    onSuccess: () => { toast.success('Proforma rejected'); setRejecting(null); setReason(''); done(); },
    onError: (e: ApiError) => toast.error(e?.message || 'Failed'),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState message="Could not load proformas" onRetry={q.refetch} />;
  const rows = q.data?.data ?? [];

  return (
    <>
      <ScrollView contentContainerStyle={styles.list}>
        {rows.length === 0 ? (
          <EmptyState icon="document-text-outline" title="No proformas pending" subtitle="Proformas awaiting approval will appear here." />
        ) : (
          rows.map((p) => (
            <GlassCard key={p.id}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Txt variant="heading">{p.customerName || 'Customer'}</Txt>
                  <Txt variant="faint">{p.proformaNo || p.id.slice(0, 8)} · {fmtDate(p.createdAt)}</Txt>
                </View>
                <Txt variant="mono" weight="bold" color={colors.cyan}>{fmtKES(p.totalAmount)}</Txt>
              </View>
              <Txt variant="faint" style={{ marginTop: 4 }}>Raised by {p.createdByName || '—'}</Txt>
              <View style={styles.cardActions}>
                <NeonButton label="Approve" icon="checkmark" loading={approve.isPending} onPress={() => approve.mutate(p.id)} style={{ flex: 1 }} />
                <NeonButton label="Reject" variant="ghost" full={false} onPress={() => setRejecting(p)} style={{ flex: 1 }} />
              </View>
            </GlassCard>
          ))
        )}
      </ScrollView>

      <Sheet visible={!!rejecting} onClose={() => setRejecting(null)} title="Reject proforma">
        <Field label="Reason" placeholder="Why is this rejected?" value={reason} onChangeText={setReason} multiline
          numberOfLines={3} style={{ minHeight: 84, textAlignVertical: 'top' }} required />
        <NeonButton label="Reject proforma" variant="danger" loading={reject.isPending}
          onPress={() => { if (!reason.trim()) return toast.error('A reason is required'); rejecting && reject.mutate({ id: rejecting.id, reason }); }} />
      </Sheet>
    </>
  );
}

function makerCheckerMsg(e: ApiError): string {
  if (e?.status === 403 && String(e.message || '').toLowerCase().includes('own')) return 'You cannot approve a proforma you created.';
  if (e?.status === 403) return 'You cannot approve your own proforma (maker-checker).';
  return e?.message || 'Failed';
}
function fmtVal(v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

// Small arrow between diff values.
function Arrow() {
  return <Txt variant="faint" style={{ paddingHorizontal: 4 }}>→</Txt>;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  diffRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  cardActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
});
