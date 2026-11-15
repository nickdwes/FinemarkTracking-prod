import React from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

import { Screen, GlassCard, Txt, Loading, ErrorState, EmptyState } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { fmtKES, initials } from '@/lib/format';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function TeamScreen() {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['teamPerformance'],
    queryFn: () => SalesApi.teamPerformance(),
  });

  const reps = data?.data ?? [];
  const totals = data?.totals;
  const maxPipe = Math.max(1, ...reps.map((r) => r.pipeline || 0));

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Txt variant="title">Team Performance</Txt>
        <Txt variant="muted">Your sales team’s leads, conversions & pipeline</Txt>
      </View>

      {isLoading ? (
        <Loading label="Loading team…" />
      ) : isError ? (
        <ErrorState message={(error as any)?.message || 'Could not load team performance'} onRetry={refetch} />
      ) : (
        <FlatList
          data={reps}
          keyExtractor={(r) => r.repId}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          ListHeaderComponent={
            totals ? (
              <GlassCard neon style={{ marginBottom: spacing.md }}>
                <Txt variant="label">Team totals</Txt>
                <View style={styles.totalsRow}>
                  <Stat label="Reps" value={totals.reps} />
                  <Stat label="Leads" value={totals.leads} tint={colors.cyan} />
                  <Stat label="Completed" value={totals.completed} tint={colors.green} />
                </View>
                <View style={styles.pipelineBox}>
                  <Txt variant="faint">Team pipeline</Txt>
                  <Txt variant="mono" weight="bold" style={{ fontSize: 26, color: colors.text }}>{fmtKES(totals.pipeline)}</Txt>
                  <Txt variant="faint">{totals.accepted} accepted quote{totals.accepted === 1 ? '' : 's'}</Txt>
                </View>
              </GlassCard>
            ) : null
          }
          ListEmptyComponent={<EmptyState icon="people-outline" title="No team data" subtitle="No reps with leads or quotes yet." />}
          renderItem={({ item, index }) => (
            <GlassCard
              style={{ marginBottom: spacing.sm }}
              onPress={() => router.push(`/(app)/team/${item.repId}?repName=${encodeURIComponent(item.repName || '')}`)}
            >
              <View style={styles.repRow}>
                <LinearGradient colors={neonGradient} style={styles.avatar} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                  <Txt variant="body" weight="bold" color={colors.white}>{initials(item.repName)}</Txt>
                </LinearGradient>
                <View style={{ flex: 1 }}>
                  <View style={styles.nameRow}>
                    <Txt variant="heading" numberOfLines={1} style={{ flex: 1 }}>{item.repName}</Txt>
                    {index === 0 && item.pipeline > 0 ? <Txt style={styles.topBadge}>Top</Txt> : null}
                  </View>
                  <Txt variant="mono" weight="bold" color={colors.cyan}>{fmtKES(item.pipeline)}</Txt>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${(item.pipeline / maxPipe) * 100}%` }]} />
                  </View>
                  <View style={styles.metaRow}>
                    <Txt variant="faint">{item.leads} lead{item.leads === 1 ? '' : 's'}</Txt>
                    <Txt variant="faint">·  {item.completed} completed</Txt>
                    <Txt variant="faint">·  {item.accepted} accepted</Txt>
                  </View>
                </View>
              </View>
            </GlassCard>
          )}
        />
      )}
    </Screen>
  );
}

function Stat({ label, value, tint }: { label: string; value: number; tint?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Txt variant="mono" weight="bold" style={{ fontSize: 22, color: tint || colors.text }}>{value}</Txt>
      <Txt variant="faint">{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 120, flexGrow: 1 },
  totalsRow: { flexDirection: 'row', marginTop: spacing.md },
  pipelineBox: { marginTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.glassBorder, paddingTop: spacing.md },
  repRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  topBadge: { color: colors.green, fontSize: 10, fontWeight: '700', backgroundColor: colors.greenDim, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.glassBorder, overflow: 'hidden', marginTop: 6 },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.cyan, minWidth: 3 },
  metaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 6, flexWrap: 'wrap' },
});
