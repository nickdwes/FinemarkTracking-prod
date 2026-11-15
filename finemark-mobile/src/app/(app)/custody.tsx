import React, { useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';

import {
  Screen, GlassCard, Txt, Pill, SegmentedTabs, NeonButton, Loading, EmptyState, ErrorState, toast,
} from '@/components/ui';
import { useMyDevices, useMySims } from '@/features/technical/hooks';
import { TechApi } from '@/features/technical/api';
import { useAuth } from '@/features/auth/authStore';
import { colors, spacing, radius } from '@/theme';

export default function CustodyScreen() {
  const [seg, setSeg] = useState<'devices' | 'sims'>('devices');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'accept' | 'reject'>(null);
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);

  const devicesQ = useMyDevices();
  const simsQ = useMySims(user?.id);

  const devices = devicesQ.data?.data ?? [];
  // GET /inventory/sims (unlike /device-custody/my-devices) returns raw DB rows
  // with no camelCase mapping — acknowledged_at, operator, etc. Reading
  // item.acknowledgedAt against that response is always undefined, so a SIM
  // that's genuinely been accepted still renders as pending forever ("stuck").
  // Normalize once here so every reference below (and the render below) sees a
  // consistent field regardless of which the API actually sent.
  const sims = useMemo(
    () => (simsQ.data?.data ?? []).map((s: any) => ({
      ...s,
      acknowledgedAt: s.acknowledgedAt ?? s.acknowledged_at ?? null,
      operator: s.operator ?? s.provider ?? null,
    })),
    [simsQ.data],
  );
  const pendingSims = useMemo(() => sims.filter((s: any) => !s.acknowledgedAt), [sims]);

  // Invalidate by prefix so the technician-scoped SIM key (['tech','mySims',<id>]) is caught.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tech', 'myDevices'] });
    qc.invalidateQueries({ queryKey: ['tech', 'mySims'] });
  };

  // NOTE: device acknowledgement is deliberately NOT wired up here. GET
  // /device-custody/my-devices (useMyDevices, above) never returns an issuance-batch
  // id — it selects i.id/serial_number/imei/... from inv_items but not
  // i.issuance_batch_id — so there is no id this screen could use to call the real
  // endpoint (POST /inventory/items/issuance-batches/:batchId/acknowledge, the one
  // technician-custody.html on web actually uses). The old
  // TechApi.ackIssue()/device-custody/issue/:issueId/acknowledge path some earlier
  // version of this screen called operates on legacy tables the current inventory
  // system doesn't use, and reading item.issueId/batchId/issuanceId here (fields
  // that don't exist on this response) always failed anyway. A non-functional
  // button is worse than none, so pending devices show a status note instead — see
  // the render below — until /my-devices exposes a usable identifier.

  const returnDefective = async (item: any) => {
    try {
      await TechApi.returnDefective({ deviceId: item.id || item.deviceId, reason: 'Faulty — returned from mobile' });
      toast.success('Marked for return');
      invalidate();
    } catch (e: any) {
      toast.error(e?.message || 'Failed');
    }
  };

  const ackSim = async (sim: any, action: 'accept' | 'reject') => {
    try {
      await TechApi.ackSims({ sim_ids: [sim.id], action });
      toast.success(action === 'accept' ? 'SIM accepted' : 'SIM rejected');
      invalidate();
    } catch (e: any) {
      toast.error(e?.message || 'Failed');
    }
  };

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelected(new Set());
  };
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllPending = () => setSelected(new Set(pendingSims.map((s: any) => s.id)));

  // Backend already accepts a batch (POST /inventory/sims/acknowledge {sim_ids: [...]})
  // in one call — web only ever sends one id at a time, so this is genuinely new
  // capability, not just a UI shortcut over an existing bulk endpoint.
  const bulkAckSims = async (action: 'accept' | 'reject') => {
    if (!selected.size) return;
    setBulkBusy(action);
    try {
      const res: any = await TechApi.ackSims({ sim_ids: [...selected], action });
      const failed = res?.data?.errors?.length ?? 0;
      const okCount = res?.data?.updated ?? selected.size;
      if (failed) toast.error(`${okCount} ${action}ed, ${failed} failed — they may have changed status.`);
      else toast.success(`${okCount} SIM${okCount === 1 ? '' : 's'} ${action}ed`);
      setSelected(new Set());
      setSelectMode(false);
      invalidate();
    } catch (e: any) {
      toast.error(e?.message || 'Failed');
    } finally {
      setBulkBusy(null);
    }
  };

  return (
    <Screen
      padded={false}
      footer={
        selectMode && selected.size > 0 ? (
          <View style={styles.bulkBar}>
            <NeonButton label={`Accept (${selected.size})`} icon="checkmark-done" full={false} style={styles.flex}
              loading={bulkBusy === 'accept'} disabled={!!bulkBusy} onPress={() => bulkAckSims('accept')} />
            <NeonButton label={`Reject (${selected.size})`} icon="close" variant="ghost" full={false} style={styles.flex}
              loading={bulkBusy === 'reject'} disabled={!!bulkBusy} onPress={() => bulkAckSims('reject')} />
          </View>
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={styles.headRow}>
          <Txt variant="title">My Custody</Txt>
          {seg === 'sims' && pendingSims.length > 0 ? (
            <Pressable onPress={toggleSelectMode} hitSlop={8}>
              <Txt variant="body" style={{ color: colors.cyan }}>{selectMode ? 'Cancel' : 'Select'}</Txt>
            </Pressable>
          ) : null}
        </View>
        <SegmentedTabs
          segments={[
            { key: 'devices', label: 'Devices', count: devices.length },
            { key: 'sims', label: 'SIM cards', count: sims.length },
          ]}
          active={seg}
          onChange={(k) => { setSeg(k as any); setSelectMode(false); setSelected(new Set()); }}
        />
        {selectMode ? (
          <View style={styles.selectBar}>
            <Txt variant="muted">{selected.size} of {pendingSims.length} pending selected</Txt>
            <Pressable onPress={selectAllPending} hitSlop={8}>
              <Txt variant="body" style={{ color: colors.cyan }}>Select all</Txt>
            </Pressable>
          </View>
        ) : null}
      </View>

      {seg === 'devices' ? (
        devicesQ.isLoading ? (
          <Loading />
        ) : devicesQ.isError ? (
          <ErrorState message="Could not load devices" onRetry={devicesQ.refetch} />
        ) : (
          <FlatList
            data={devices}
            keyExtractor={(d, i) => String(d.id || d.imei || i)}
            contentContainerStyle={styles.list}
            onRefresh={devicesQ.refetch}
            refreshing={devicesQ.isRefetching}
            ListEmptyComponent={<EmptyState icon="cube-outline" title="No devices in custody" subtitle="Devices issued to you will appear here." />}
            renderItem={({ item }) => {
              const pending = String(item.inventoryStatus || item.status || '').toLowerCase().includes('issued') && !item.acknowledgedAt;
              return (
                <GlassCard>
                  <View style={styles.row}>
                    <View style={styles.icon}><Ionicons name="hardware-chip-outline" size={20} color={colors.cyan} /></View>
                    <View style={{ flex: 1 }}>
                      <Txt variant="mono" weight="semibold">{item.imei || item.serial || item.id}</Txt>
                      <Txt variant="faint">{item.productName || item.model || 'Tracker device'}</Txt>
                    </View>
                    <Pill label={item.inventoryStatus || item.status || 'In custody'} />
                  </View>
                  {pending ? (
                    // See the comment above CustodyScreen's returnDefective for why this
                    // isn't an Accept/Reject action — acknowledge it from the web portal's
                    // Technician Custody page for now.
                    <View style={styles.actions}>
                      <Txt variant="faint">Awaiting your acknowledgement — accept this device from the web portal's Technician Custody page.</Txt>
                    </View>
                  ) : (
                    <View style={styles.actions}>
                      <NeonButton label="Return defective" icon="alert-circle-outline" variant="subtle" full={false}
                        onPress={() => returnDefective(item)} style={styles.flex} />
                    </View>
                  )}
                </GlassCard>
              );
            }}
          />
        )
      ) : simsQ.isLoading ? (
        <Loading />
      ) : simsQ.isError ? (
        <ErrorState message="Could not load SIMs" onRetry={simsQ.refetch} />
      ) : (
        <FlatList
          data={sims}
          keyExtractor={(s, i) => String(s.id || s.msisdn || i)}
          contentContainerStyle={styles.list}
          onRefresh={simsQ.refetch}
          refreshing={simsQ.isRefetching}
          ListEmptyComponent={<EmptyState icon="cellular-outline" title="No SIMs in custody" subtitle="SIMs issued to you will appear here." />}
          renderItem={({ item }) => {
            const pending = !item.acknowledgedAt;
            const isSelected = selected.has(item.id);
            const card = (
              <GlassCard style={selectMode && pending && isSelected ? styles.selectedCard : undefined}>
                <View style={styles.row}>
                  {selectMode && pending ? (
                    <Ionicons name={isSelected ? 'checkbox' : 'square-outline'} size={22} color={isSelected ? colors.cyan : colors.textFaint} />
                  ) : (
                    <View style={styles.icon}><Ionicons name="cellular-outline" size={20} color={colors.violet} /></View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Txt variant="mono" weight="semibold">{item.msisdn || item.phone || item.iccid || item.id}</Txt>
                    <Txt variant="faint">{item.iccid ? `ICCID ${item.iccid}` : item.operator || 'SIM card'}</Txt>
                  </View>
                  <Pill label={item.status || 'issued'} />
                </View>
                {pending && !selectMode ? (
                  <View style={styles.actions}>
                    <NeonButton label="Accept" icon="checkmark" full={false} onPress={() => ackSim(item, 'accept')} style={styles.flex} />
                    <NeonButton label="Reject" icon="close" variant="ghost" full={false} onPress={() => ackSim(item, 'reject')} style={styles.flex} />
                  </View>
                ) : null}
              </GlassCard>
            );
            return selectMode && pending ? (
              <Pressable onPress={() => toggleSelected(item.id)}>{card}</Pressable>
            ) : card;
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  flex: { flex: 1 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  selectedCard: { borderColor: colors.cyan, borderWidth: 1 },
  bulkBar: { flexDirection: 'row', gap: spacing.sm },
});
