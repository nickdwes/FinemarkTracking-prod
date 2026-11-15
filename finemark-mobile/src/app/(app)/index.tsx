import React, { useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Screen, GlassCard, Txt, Pill, Sheet, Divider, Loading, EmptyState, toast } from '@/components/ui';
import { useAuth } from '@/features/auth/authStore';
import { baseRole, TECHNICAL_ROLES, SALES_ROLES, ROLES, APPROVER_ROLES } from '@/constants/roles';
import { useMyTickets } from '@/features/technical/hooks';
import { SalesApi } from '@/features/sales/api';
import { NotificationsApi } from '@/features/notifications/api';
import { useIsOnline } from '@/lib/online';
import { fmtRelative, fmtKES } from '@/lib/format';
import { colors, spacing, radius } from '@/theme';

export default function HomeDashboard() {
  const user = useAuth((s) => s.user);
  const role = baseRole(user);
  const router = useRouter();
  const qc = useQueryClient();
  const online = useIsOnline();
  const [notifOpen, setNotifOpen] = useState(false);

  const isTech = TECHNICAL_ROLES.includes(role) || role === ROLES.ADMIN;
  const isSales = SALES_ROLES.includes(role);
  const isFinance = role === ROLES.FINANCE;

  const notifQ = useQuery({ queryKey: ['notifications'], queryFn: () => NotificationsApi.list() });
  const leadStatsQ = useQuery({ queryKey: ['leadStats'], queryFn: () => SalesApi.leadStats(), enabled: isSales });
  const custStatsQ = useQuery({ queryKey: ['customerStats'], queryFn: () => SalesApi.customerStats(), enabled: isSales });
  const pipelineQ = useQuery({ queryKey: ['pipelineValue'], queryFn: () => SalesApi.pipelineValue(), enabled: isSales });
  const ticketsQ = useMyTickets();

  const firstName = (user?.name || user?.email || '').split(/[ @]/)[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const unread = notifQ.data?.unread ?? 0;
  const notifications = notifQ.data?.notifications ?? [];

  // KPI + pipeline data (real)
  const stats = leadStatsQ.data?.stats ?? {};
  const jobStatus: Record<string, number> = ticketsQ.data?.meta?.byStatus ?? {};

  const kpis: { label: string; value: number | string; tint: string }[] = [];
  if (isSales) {
    // Buckets keyed off the linked job card, not the lead's own status.
    const active = (stats.NotSubmitted ?? 0) + (stats.ActiveJobs ?? 0);
    const won = stats.CompletedJobs ?? 0;
    kpis.push({ label: 'Active leads', value: active, tint: colors.cyan });
    kpis.push({ label: 'Customers', value: custStatsQ.data?.total ?? '—', tint: colors.violet });
    kpis.push({ label: 'Completed', value: won, tint: colors.green });
  } else if (isTech) {
    kpis.push({ label: 'Assigned', value: jobStatus['Assigned'] ?? 0, tint: colors.cyan });
    kpis.push({ label: 'In progress', value: jobStatus['InProgress'] ?? jobStatus['In Progress'] ?? 0, tint: colors.amber });
    kpis.push({ label: 'Completed', value: jobStatus['Completed'] ?? 0, tint: colors.green });
  }

  const pipeline = isSales
    ? [
        { label: 'New', value: stats.NotSubmitted ?? 0, tint: colors.blue },
        { label: 'In progress', value: stats.ActiveJobs ?? 0, tint: colors.cyan },
        { label: 'Completed', value: stats.CompletedJobs ?? 0, tint: colors.green },
        { label: 'Paid', value: stats.Paid ?? 0, tint: colors.green },
      ]
    : isTech
      ? [
          { label: 'Assigned', value: jobStatus['Assigned'] ?? 0, tint: colors.cyan },
          { label: 'In progress', value: jobStatus['InProgress'] ?? jobStatus['In Progress'] ?? 0, tint: colors.violet },
          { label: 'On hold', value: jobStatus['On Hold'] ?? 0, tint: colors.amber },
          { label: 'Completed', value: jobStatus['Completed'] ?? 0, tint: colors.green },
        ]
      : [];
  const pipeMax = Math.max(1, ...pipeline.map((p) => p.value));

  // Semantic quick actions: green = create, amber = approvals, blue = reports, cyan/violet = modules
  const actions: { label: string; icon: keyof typeof Ionicons.glyphMap; href: string; tint: string }[] = [];
  if (isSales) {
    // Sales team: create actions + Quotations (no Approvals / Reports).
    actions.push({ label: 'Retail lead', icon: 'flash', href: '/(app)/leads/new?type=retail', tint: colors.green });
    actions.push({ label: 'Corporate', icon: 'business', href: '/(app)/leads/new?type=corporate', tint: colors.green });
    actions.push({ label: 'Customer', icon: 'person-add', href: '/(app)/customers/new', tint: colors.green });
    actions.push({ label: 'Quotations', icon: 'document-text', href: '/(app)/quotations', tint: colors.cyan });
  } else {
    if (isTech) {
      actions.push({ label: 'My jobs', icon: 'construct', href: '/(app)/jobs', tint: colors.cyan });
      actions.push({ label: 'Custody', icon: 'cube', href: '/(app)/custody', tint: colors.violet });
    }
    if (isFinance) actions.push({ label: 'Invoices', icon: 'receipt', href: '/(app)/invoices', tint: colors.cyan });
    // Only roles the backend actually lets approve something here (Admin/Finance/
    // BDM/BDMCorporate — see APPROVER_ROLES) — a Technician (or ISO/InstallOffice/
    // Executive) has no approval authority at all, so the tile just led to an
    // always-empty/erroring screen for them.
    if (APPROVER_ROLES.includes(role)) actions.push({ label: 'Approvals', icon: 'shield-checkmark', href: '/(app)/approvals', tint: colors.amber });
    actions.push({ label: 'Reports', icon: 'bar-chart', href: '/(app)/reports', tint: colors.blue });
  }

  const refreshAll = () => {
    notifQ.refetch();
    if (isSales) { leadStatsQ.refetch(); custStatsQ.refetch(); pipelineQ.refetch(); }
    if (isTech) ticketsQ.refetch();
  };

  const markAllRead = async () => {
    try {
      await NotificationsApi.markAllRead();
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('All caught up');
    } catch { /* noop */ }
  };

  return (
    <Screen scroll onRefresh={refreshAll} refreshing={notifQ.isRefetching}>
      {/* Compact header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Txt variant="muted" style={{ lineHeight: 16 }}>{greeting},</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap', marginTop: 2 }}>
            <Txt variant="title" style={{ lineHeight: 30 }}>{firstName || 'there'}</Txt>
            <Pill label={user?.role || 'User'} fg={colors.violet} bg={colors.violetDim} />
            {!online ? <Pill label="Offline" fg={colors.amber} bg={colors.amberDim} /> : null}
          </View>
        </View>
        <View style={styles.headerIcons}>
          <Pressable onPress={() => setNotifOpen(true)} style={styles.iconBtn} hitSlop={8}>
            <Ionicons name="notifications-outline" size={22} color={colors.text} />
            {unread > 0 ? <View style={styles.badge}><Txt style={styles.badgeTxt}>{unread > 9 ? '9+' : unread}</Txt></View> : null}
          </Pressable>
          <Pressable onPress={() => router.push('/(app)/me')} style={styles.avatar}>
            <Txt variant="heading" color={colors.cyan}>{(firstName[0] || '?').toUpperCase()}</Txt>
          </Pressable>
        </View>
      </View>

      {/* Search */}
      <Pressable style={styles.search} onPress={() => router.push('/(app)/customers')}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <Txt variant="muted" style={{ marginLeft: spacing.sm }}>Search name, phone or vehicle reg…</Txt>
      </Pressable>

      {/* Pipeline value hero (sales) */}
      {isSales && pipelineQ.data ? (
        <GlassCard neon style={{ marginTop: spacing.lg }}>
          <View style={styles.heroRow}>
            <View style={{ flex: 1 }}>
              <Txt variant="label">Pipeline value</Txt>
              <Txt variant="mono" weight="bold" style={{ fontSize: 32, color: colors.text, marginTop: 2 }}>
                {fmtKES(pipelineQ.data.pipelineValue)}
              </Txt>
              <Txt variant="faint" style={{ marginTop: 2 }}>
                Quoted {fmtKES(pipelineQ.data.quotedValue)} · Invoiced {fmtKES(pipelineQ.data.invoicedValue)}
              </Txt>
            </View>
            <View style={styles.heroIcon}>
              <Ionicons name="trending-up" size={26} color={colors.green} />
            </View>
          </View>
        </GlassCard>
      ) : null}

      {/* KPIs */}
      {kpis.length ? (
        <View style={styles.kpiRow}>
          {kpis.map((k) => (
            <GlassCard key={k.label} style={styles.kpiCard} padded={false}>
              <View style={styles.kpiInner}>
                <Txt variant="mono" weight="bold" style={{ fontSize: 26, color: k.tint }}>{k.value}</Txt>
                <Txt variant="faint" numberOfLines={1}>{k.label}</Txt>
              </View>
            </GlassCard>
          ))}
        </View>
      ) : null}

      {/* Pipeline / status */}
      {pipeline.length ? (
        <GlassCard style={{ marginTop: spacing.md }}>
          <Txt variant="label" style={{ marginBottom: spacing.md }}>{isSales ? 'Lead pipeline' : 'Job status'}</Txt>
          {pipeline.map((p) => (
            <View key={p.label} style={styles.pipeRow}>
              <Txt variant="muted" style={{ width: 96 }} numberOfLines={1}>{p.label}</Txt>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${(p.value / pipeMax) * 100}%`, backgroundColor: p.tint }]} />
              </View>
              <Txt variant="mono" weight="bold" style={{ width: 34, textAlign: 'right', color: p.tint }}>{p.value}</Txt>
            </View>
          ))}
        </GlassCard>
      ) : null}

      {/* Quick actions — compact, semantic colors */}
      <Txt variant="label" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>Quick actions</Txt>
      <View style={styles.actionsWrap}>
        {actions.map((a) => (
          <Pressable key={a.label} style={styles.actionTile} onPress={() => router.push(a.href as any)}>
            <GlassCard padded={false} style={styles.actionCard}>
              <View style={styles.actionInner}>
                <View style={[styles.actionIcon, { backgroundColor: a.tint + '22' }]}>
                  <Ionicons name={a.icon} size={18} color={a.tint} />
                </View>
                <Txt variant="muted" weight="semibold" numberOfLines={1} style={{ marginTop: 6, color: colors.text }}>{a.label}</Txt>
              </View>
            </GlassCard>
          </Pressable>
        ))}
      </View>

      {/* Recent activity */}
      <Txt variant="label" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>Recent activity</Txt>
      <GlassCard>
        {notifQ.isLoading ? (
          <Loading />
        ) : notifications.length === 0 ? (
          <Txt variant="faint" style={{ paddingVertical: spacing.sm }}>Nothing new right now.</Txt>
        ) : (
          notifications.slice(0, 5).map((n, i) => (
            <View key={n.id}>
              {i > 0 ? <Divider spacer={spacing.sm} /> : null}
              <View style={styles.actRow}>
                <View style={[styles.dot, { backgroundColor: n.read ? colors.textFaint : colors.cyan }]} />
                <View style={{ flex: 1 }}>
                  <Txt variant="body" numberOfLines={1}>{n.title || n.type || 'Update'}</Txt>
                  {n.body ? <Txt variant="faint" numberOfLines={1}>{n.body}</Txt> : null}
                </View>
                <Txt variant="faint">{fmtRelative(n.createdAt)}</Txt>
              </View>
            </View>
          ))
        )}
      </GlassCard>

      {/* Notifications sheet */}
      <Sheet visible={notifOpen} onClose={() => setNotifOpen(false)} title="Notifications">
        {notifications.length === 0 ? (
          <EmptyState icon="notifications-off-outline" title="No notifications" subtitle="You're all caught up." />
        ) : (
          <>
            <Pressable onPress={markAllRead} style={{ alignSelf: 'flex-end', paddingVertical: spacing.sm }}>
              <Txt variant="muted" style={{ color: colors.cyan }}>Mark all read</Txt>
            </Pressable>
            {notifications.map((n, i) => (
              <View key={n.id}>
                {i > 0 ? <Divider spacer={spacing.sm} /> : null}
                <View style={styles.actRow}>
                  <View style={[styles.dot, { backgroundColor: n.read ? colors.textFaint : colors.cyan }]} />
                  <View style={{ flex: 1 }}>
                    <Txt variant="body">{n.title || n.type || 'Update'}</Txt>
                    {n.body ? <Txt variant="faint">{n.body}</Txt> : null}
                    <Txt variant="faint" style={{ marginTop: 2 }}>{fmtRelative(n.createdAt)}</Txt>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.sm },
  headerIcons: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconBtn: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glassStrong },
  badge: { position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeTxt: { color: colors.white, fontSize: 10, fontWeight: '700' },
  avatar: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.cyanDim, borderWidth: 1, borderColor: colors.glassBorderNeon, alignItems: 'center', justifyContent: 'center' },
  search: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg,
    backgroundColor: colors.glassStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder,
    borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroIcon: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.greenDim, alignItems: 'center', justifyContent: 'center' },
  kpiRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  kpiCard: { flex: 1 },
  kpiInner: { padding: spacing.md, alignItems: 'flex-start' },
  pipeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.sm },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.glassBorder, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, minWidth: 3 },
  actionsWrap: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs },
  actionTile: { width: '33.333%', padding: spacing.xs },
  actionCard: { minHeight: 84 },
  actionInner: { padding: spacing.sm, alignItems: 'center', justifyContent: 'center', minHeight: 84 },
  actionIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  actRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
