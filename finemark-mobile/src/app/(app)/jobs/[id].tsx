import React, { useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import {
  Screen, GlassCard, Txt, Pill, NeonButton, Divider, KeyValue, StatusRing,
  Loading, ErrorState, Sheet, Field, toast,
} from '@/components/ui';
import { useTicket, useTicketMutation } from '@/features/technical/hooks';
import { TechApi, type Ticket } from '@/features/technical/api';
import { LifecycleActions } from '@/features/technical/LifecycleActions';
import { JobWizard } from '@/features/technical/JobWizard';
import { EvidencePicker, type Evidence } from '@/features/technical/EvidencePicker';
import { tryGetPosition } from '@/features/technical/location';
import { useAuth } from '@/features/auth/authStore';
import { baseRole, ROLES } from '@/constants/roles';
import { fmtDate } from '@/lib/format';
import { colors, spacing, radius } from '@/theme';

// Matches job-card.html's canEngineer role gate exactly (renderStage8 / updateS8CloseBtn).
// 'Support' isn't in the mobile ROLES const (it isn't in the backend's canonical ROLES
// enum either — it's a legacy raw role string some accounts still carry) but the web
// job card gates the ISO/engineer sign-off and job-close controls on it, so it has to
// be listed literally here too, the same way custom roles like technical_manager are.
const ISO_ROLES: string[] = [ROLES.TECHNICAL, ROLES.INSTALL_OFFICE, ROLES.ADMIN, 'Support'];

function progressOf(t: Ticket): number {
  const s = (t.status || '').toLowerCase();
  if (s.includes('completed') || s.includes('closed')) return 100;
  return Math.min(95, Math.round(((t.stage ?? 0) / 8) * 100));
}

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const role = baseRole(user);
  const isIso = ISO_ROLES.includes(role);

  const { data, isLoading, isError, error, refetch, isRefetching } = useTicket(id!);
  const t = data?.data;

  const [attachOpen, setAttachOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [sitePhotos, setSitePhotos] = useState<Evidence[]>([]);

  const ack = useTicketMutation((body: any) => TechApi.acknowledge(id!, body), { ticketId: id, successMsg: 'Job acknowledged' });
  const travel = useTicketMutation((body: any) => TechApi.travelStart(id!, body), { ticketId: id, successMsg: 'Travel started' });
  const arrive = useTicketMutation((body: any) => TechApi.arrived(id!, body), { ticketId: id, successMsg: 'Marked as arrived' });
  const notifyIso = useTicketMutation(() => TechApi.notifyIso(id!), { ticketId: id, successMsg: 'ISO notified for activation' });
  const activationApprove = useTicketMutation((body: any) => TechApi.activationApprove(id!, body), { ticketId: id, successMsg: 'Activation approved' });
  const activationReject = useTicketMutation((body: any) => TechApi.activationReject(id!, body), { ticketId: id, successMsg: 'Activation rejected' });
  const signOff = useTicketMutation((body: any) => TechApi.updateStatus(id!, body), { ticketId: id, successMsg: 'Signed off' });
  const complete = useTicketMutation((body: any) => TechApi.updateStatus(id!, body), { ticketId: id, successMsg: 'Job completed' });

  if (isLoading) return <Screen><Loading label="Loading job…" /></Screen>;
  if (isError || !t) return <Screen><ErrorState message={(error as any)?.message || 'Job not found'} onRetry={refetch} /></Screen>;

  const status = t.status || 'Pending';
  const acknowledged = !!t.acknowledgedAt;
  const travelling = !!t.travelStartedAt && !t.arrivedAt;
  const arrived = !!t.arrivedAt;
  const isTerminal = ['Completed', 'Closed', 'Cancelled', 'Defaulted'].includes(status);
  const held = t.statusReason && ['On Hold', 'Rescheduled', 'Cancelled', 'Defaulted'].includes(status);

  // GPS is optional server-side — capture it when we can, but never block check-in
  // on it. A denied permission, disabled services, no signal, or a dev-client build
  // without the native location module all fall back to proceeding without coordinates.
  const withGps = async (run: (gps: any) => void) => {
    const r = await tryGetPosition();
    if (r.ok) {
      run(r.fix);
      return;
    }
    const note =
      r.reason === 'unavailable'
        ? 'Location not available in this build — recording without GPS.'
        : r.reason === 'denied'
          ? 'Location permission off — recording without GPS.'
          : r.reason === 'disabled'
            ? 'Location services off — recording without GPS.'
            : 'No location fix — recording without GPS.';
    toast.info(note);
    run({});
  };

  return (
    <Screen padded={false}>
      {/* Header */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Txt variant="mono" weight="bold" color={colors.cyan}>
          {t.ticketNo || t.id.slice(0, 8)}
        </Txt>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={undefined}
      >
        {/* Summary */}
        <GlassCard neon>
          <View style={styles.summaryRow}>
            <View style={{ flex: 1 }}>
              <Txt variant="title" numberOfLines={1}>
                {t.vehicleRegistration || 'No registration'}
              </Txt>
              <Txt variant="muted">{t.customerName || '—'}</Txt>
              <View style={{ marginTop: spacing.sm, flexDirection: 'row' }}>
                <Pill label={status} />
              </View>
            </View>
            <StatusRing progress={progressOf(t)} size={64} />
          </View>
          <Divider />
          <KeyValue label="Technician" value={t.assignedToName || t.assignedToEmail} />
          <KeyValue label="ISO officer" value={t.isoName || t.isoEmail} />
          {t.notes ? <KeyValue label="Notes" value={t.notes} /> : null}
        </GlassCard>

        {/* Lifecycle banner */}
        {held ? (
          <GlassCard style={{ borderColor: colors.amber + '55', borderWidth: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.amber} />
              <Txt variant="label" style={{ color: colors.amber, marginLeft: 6 }}>
                {status}
              </Txt>
            </View>
            <Txt variant="body" style={{ marginTop: spacing.sm }}>
              {t.statusReason}
            </Txt>
            {t.rescheduledTo ? <Txt variant="muted" style={{ marginTop: 4 }}>New date: {fmtDate(t.rescheduledTo)}</Txt> : null}
            {Array.isArray(t.statusEvidence) && t.statusEvidence.length ? (
              <Txt variant="faint" style={{ marginTop: 4 }}>{t.statusEvidence.length} evidence file(s) attached</Txt>
            ) : null}
          </GlassCard>
        ) : null}

        {/* Contextual GPS actions */}
        {!isTerminal ? (
          <GlassCard>
            <Txt variant="label" style={{ marginBottom: spacing.sm }}>
              Progress
            </Txt>
            {!acknowledged ? (
              <View style={{ gap: spacing.sm }}>
                <NeonButton label="Accept job" icon="checkmark-outline" loading={ack.isPending}
                  onPress={() => withGps((gps) => ack.mutate({ accept: true, ...gps }))} />
                <NeonButton label="Reject job" icon="close-outline" variant="ghost" onPress={() => setRejectOpen(true)} />
              </View>
            ) : !travelling && !arrived ? (
              <NeonButton label="Start travel" icon="navigate-outline" loading={travel.isPending}
                onPress={() => withGps((gps) => travel.mutate(gps))} />
            ) : travelling ? (
              <NeonButton label="I've arrived on site" icon="location-outline" loading={arrive.isPending}
                onPress={() => withGps((gps) => arrive.mutate(gps))} />
            ) : (
              <Txt variant="muted">On site — proceed with the installation steps below.</Txt>
            )}
          </GlassCard>
        ) : null}

        {/* Paginated 8-step installation journey (on site) */}
        {!isTerminal && arrived ? (
          <>
            <JobWizard ticket={t} isIso={isIso} onDone={refetch} />
            <NeonButton label="Attach device to job" icon="cube-outline" variant="ghost" onPress={() => setAttachOpen(true)} />
          </>
        ) : null}

        {/* Lifecycle actions (pause / reschedule / cancel / default / resume) */}
        {!isTerminal ? (
          <GlassCard>
            <LifecycleActions ticket={t} onDone={refetch} />
          </GlassCard>
        ) : null}
      </ScrollView>

      {/* Reject-job sheet */}
      <Sheet visible={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject job">
        <Field label="Reason" placeholder="Why are you rejecting?" value={rejectReason} onChangeText={setRejectReason}
          multiline numberOfLines={3} style={{ minHeight: 84, textAlignVertical: 'top' }} required />
        <NeonButton label="Reject job" variant="danger" loading={ack.isPending}
          onPress={() => {
            if (!rejectReason.trim()) return toast.error('A reason is required');
            withGps((gps) => ack.mutate({ accept: false, rejectionReason: rejectReason.trim(), ...gps }));
            setRejectOpen(false);
            setRejectReason('');
          }} />
      </Sheet>

      {/* Attach device sheet */}
      <AttachDeviceSheet ticket={t} visible={attachOpen} onClose={() => setAttachOpen(false)} onDone={refetch} />
    </Screen>
  );
}

function AttachDeviceSheet({ ticket, visible, onClose, onDone }: { ticket: Ticket; visible: boolean; onClose: () => void; onDone: () => void }) {
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [msisdn, setMsisdn] = useState('');
  const [simIccid, setSimIccid] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await TechApi.availableForJob();
      setDevices(res?.data ?? []);
    } catch (e: any) {
      toast.error(e?.message || 'Could not load devices');
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (visible) { setQuery(''); setMsisdn(''); setSimIccid(''); load(); }
  }, [visible]);

  const attach = useTicketMutation((body: any) => TechApi.assignToJob(body), {
    ticketId: ticket.id,
    successMsg: 'Device attached',
    onDone: () => { onClose(); onDone(); },
  });

  // Filter by IMEI / serial / product. Numbers only in the query still match IMEIs.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? devices.filter((d) => {
        const hay = `${d.imei ?? ''} ${d.serialNumber ?? d.serial ?? ''} ${d.productName ?? d.deviceModel ?? d.model ?? ''} ${d.id ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
    : devices;

  return (
    <Sheet visible={visible} onClose={onClose} title="Attach device" scroll={false}>
      {loading ? (
        <Loading />
      ) : devices.length === 0 ? (
        <Txt variant="muted">No acknowledged devices available. Accept an issued device in Custody first.</Txt>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {/* Pinned IMEI search */}
          <View style={styles.searchRow}>
            <Ionicons name="search-outline" size={18} color={colors.textFaint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search IMEI, serial or product…"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              style={styles.searchInput}
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </View>
          <Txt variant="faint">{filtered.length} of {devices.length} device{devices.length === 1 ? '' : 's'}</Txt>

          {/* Scrollable device list */}
          <ScrollView style={styles.deviceScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.sm }}>
            {filtered.length === 0 ? (
              <Txt variant="muted" style={{ paddingVertical: spacing.md }}>No devices match “{query}”.</Txt>
            ) : (
              filtered.map((d) => {
                const idv = d.id || d.deviceId || d.imei;
                const on = selected === idv;
                return (
                  <Pressable key={idv} onPress={() => setSelected(idv)}
                    style={[styles.deviceRow, on && { borderColor: colors.glassBorderNeon, backgroundColor: colors.cyanDim }]}>
                    <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={18} color={on ? colors.cyan : colors.textFaint} />
                    <View style={{ marginLeft: spacing.sm, flex: 1 }}>
                      <Txt variant="body" weight="semibold">{d.imei || d.serialNumber || d.serial || idv}</Txt>
                      <Txt variant="faint">{d.productName || d.deviceModel || d.model || 'Device'}</Txt>
                      {d.requiresSim ? <Txt variant="faint" style={{ color: colors.amber }}>Requires SIM</Txt> : null}
                    </View>
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          {/* SIM ICCID — POST /device-custody/assign-to-job accepts simIccid alongside
              msisdn. Without capturing it here, any requires_sim device attached from
              mobile has no way to avoid later tripping the MISSING_SIM completion
              blocker (getCompletionBlockers in installation-tickets.ts). */}
          <Field label="SIM ICCID" placeholder="8925… (printed on the SIM card)" autoCapitalize="characters"
            value={simIccid} onChangeText={setSimIccid} />
          <Field label="SIM number (MSISDN)" placeholder="07…" keyboardType="phone-pad" value={msisdn} onChangeText={setMsisdn} />
          <NeonButton label="Attach to job" loading={attach.isPending}
            onPress={() => {
              if (!selected) return toast.error('Select a device');
              attach.mutate({
                deviceId: selected,
                jobId: ticket.id,
                vehicleId: ticket.vehicleId,
                vehicleRegistration: ticket.vehicleRegistration,
                simIccid: simIccid.trim() || undefined,
                msisdn: msisdn.trim() || undefined,
              });
            }} />
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  back: { width: 24 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  okRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  deviceRow: {
    flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, backgroundColor: colors.glassStrong,
  },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, height: 44, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, backgroundColor: colors.glassStrong,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, padding: 0 },
  deviceScroll: { maxHeight: 360 },
});
