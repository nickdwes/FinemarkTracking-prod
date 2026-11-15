import React from 'react';
import { View, StyleSheet, Pressable, ScrollView, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { Screen, GlassCard, Txt, Pill, Divider, KeyValue, Loading, ErrorState, IconChip } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { initials, fmtKES, fmtDate } from '@/lib/format';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function Customer360() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['customer360', id],
    queryFn: () => SalesApi.customer360(id!),
    enabled: !!id,
  });

  if (isLoading) return <Screen><Loading label="Loading customer…" /></Screen>;
  if (isError) return <Screen><ErrorState message={(error as any)?.message || 'Could not load customer'} onRetry={refetch} /></Screen>;

  const customer = data?.customer || {};
  const profile = data?.profile || {};
  const contacts: any[] = data?.contacts || [];
  const vehicles: any[] = data?.vehicles || data?.vehicleRows || [];
  const installedDevices: any[] = data?.installedDevices || [];
  const devices: any[] = data?.devices || [];
  const subscriptions: any[] = data?.subscriptions || [];
  const tickets: any[] = data?.tickets || [];
  const invoices: any[] = data?.invoices || [];
  const certificates: any[] = data?.certificates || [];

  const name = customer.displayName || profile.fullName || profile.companyName || 'Customer';
  const phone = profile.phone && profile.phone !== '—' ? profile.phone : contacts[0]?.phone;
  const email = profile.email && profile.email !== '—' ? profile.email : contacts[0]?.email;

  return (
    <Screen padded={false}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="chevron-back" size={24} color={colors.text} /></Pressable>
        <Txt variant="muted">Customer 360</Txt>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md }}
        showsVerticalScrollIndicator={false} refreshControl={undefined}>

        {/* Identity */}
        <GlassCard neon>
          <View style={styles.identity}>
            <LinearGradient colors={neonGradient} style={styles.avatar} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Txt variant="heading" color={colors.white}>{initials(name)}</Txt>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Txt variant="title" numberOfLines={2}>{name}</Txt>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill label={customer.status || 'Active'} />
                <Txt variant="faint">{customer.type || 'individual'}{customer.accountNo ? ` · ${customer.accountNo}` : ''}</Txt>
              </View>
            </View>
          </View>
          {(phone || email) ? (
            <View style={styles.contactChips}>
              {phone ? <IconChip icon="call-outline" label="Call" onPress={() => Linking.openURL(`tel:${phone}`)} /> : null}
              {phone ? <IconChip icon="logo-whatsapp" label="WhatsApp" onPress={() => Linking.openURL(`https://wa.me/${String(phone).replace(/\D/g, '')}`)} /> : null}
              {email ? <IconChip icon="mail-outline" label="Email" onPress={() => Linking.openURL(`mailto:${email}`)} /> : null}
            </View>
          ) : null}
        </GlassCard>

        {/* Profile */}
        <GlassCard>
          <Txt variant="label" style={{ marginBottom: spacing.sm }}>Profile</Txt>
          <KeyValue label="Phone" value={phone} />
          <KeyValue label="Email" value={email} />
          <KeyValue label="Region" value={customer.region} />
          <KeyValue label="Address" value={profile.address || profile.physicalAddress} />
          {profile.kraPin ? <KeyValue label="KRA PIN" value={profile.kraPin} /> : null}
          <KeyValue label="Source" value={customer.source} />
          <KeyValue label="Account manager" value={customer.accountManagerEmail} />
        </GlassCard>

        {contacts.length > 1 ? (
          <Panel title={`Contacts (${contacts.length})`}>
            {contacts.map((c, i) => (
              <View key={c.id || i}>
                {i > 0 ? <Divider spacer={spacing.sm} /> : null}
                <Txt variant="body" weight="semibold">{c.name || c.contactName || '—'} {c.isPrimary ? '· primary' : ''}</Txt>
                <Txt variant="faint">{[c.phone, c.email].filter((x) => x && x !== '—').join(' · ') || '—'}</Txt>
              </View>
            ))}
          </Panel>
        ) : null}

        {/* Vehicles */}
        <Panel title={`Vehicles (${vehicles.length})`} empty={vehicles.length === 0}>
          {vehicles.map((v, i) => (
            <View key={v.id || i}>
              {i > 0 ? <Divider spacer={spacing.sm} /> : null}
              <View style={styles.rowBetween}>
                <Txt variant="body" weight="semibold">{v.registration || v.chassis_number || 'Unregistered'}</Txt>
                {v.status ? <Pill label={v.status} /> : null}
              </View>
              <Txt variant="faint">{[v.make, v.model, v.year_of_manufacture].filter(Boolean).join(' · ') || '—'}</Txt>
            </View>
          ))}
        </Panel>

        {/* Installed devices */}
        <Panel title={`Installed devices (${installedDevices.length})`} empty={installedDevices.length === 0}>
          {installedDevices.map((d, i) => (
            <View key={d.id || i}>
              {i > 0 ? <Divider spacer={spacing.sm} /> : null}
              <Txt variant="mono" weight="semibold">{d.imei || d.serialNumber || '—'}</Txt>
              <Txt variant="faint">{[d.productName, d.vehicleRegistration, d.ticketNo].filter(Boolean).join(' · ')}</Txt>
            </View>
          ))}
        </Panel>

        {/* Subscriptions */}
        {subscriptions.length ? (
          <Panel title={`Subscriptions (${subscriptions.length})`}>
            {subscriptions.map((s, i) => (
              <View key={s.id || i}>
                {i > 0 ? <Divider spacer={spacing.sm} /> : null}
                <View style={styles.rowBetween}>
                  <Txt variant="body" weight="semibold">{s.planName || s.serviceType || 'Plan'}</Txt>
                  {s.status ? <Pill label={s.status} /> : null}
                </View>
                <Txt variant="faint">{s.monthlyFee ? `${fmtKES(s.monthlyFee)}/mo` : ''}{s.endDate ? ` · ends ${fmtDate(s.endDate)}` : ''}</Txt>
              </View>
            ))}
          </Panel>
        ) : null}

        {/* Invoices */}
        {invoices.length ? (
          <Panel title={`Invoices (${invoices.length})`}>
            {invoices.map((inv, i) => (
              <View key={inv.id || i}>
                {i > 0 ? <Divider spacer={spacing.sm} /> : null}
                <View style={styles.rowBetween}>
                  <Txt variant="body">{inv.invoiceNumber || inv.id?.slice(0, 8)}</Txt>
                  <Txt variant="mono" weight="semibold" color={colors.cyan}>{fmtKES(inv.amount)}</Txt>
                </View>
                <View style={styles.rowBetween}>
                  <Txt variant="faint">{inv.dueOn ? `due ${fmtDate(inv.dueOn)}` : ''}</Txt>
                  {inv.status ? <Pill label={inv.status} /> : null}
                </View>
              </View>
            ))}
          </Panel>
        ) : null}

        {/* Tickets + certs summary */}
        {tickets.length ? (
          <Panel title={`Support tickets (${tickets.length})`}>
            {tickets.slice(0, 8).map((t, i) => (
              <View key={t.id || i}>
                {i > 0 ? <Divider spacer={spacing.sm} /> : null}
                <View style={styles.rowBetween}>
                  <Txt variant="body" numberOfLines={1} style={{ flex: 1 }}>{t.subject || t.ticketNo || 'Ticket'}</Txt>
                  {t.status ? <Pill label={t.status} /> : null}
                </View>
              </View>
            ))}
          </Panel>
        ) : null}

        {certificates.length ? (
          <GlassCard>
            <View style={styles.rowBetween}>
              <Txt variant="label">Certificates</Txt>
              <Txt variant="mono" weight="bold" color={colors.green}>{certificates.length}</Txt>
            </View>
          </GlassCard>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Panel({ title, children, empty }: { title: string; children?: React.ReactNode; empty?: boolean }) {
  return (
    <GlassCard>
      <Txt variant="label" style={{ marginBottom: spacing.sm }}>{title}</Txt>
      {empty ? <Txt variant="faint">None on record.</Txt> : children}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 56, height: 56, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  contactChips: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
});
