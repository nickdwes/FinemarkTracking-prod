import React, { useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { Screen, GlassCard, Txt, Pill, SegmentedTabs, Loading, EmptyState, ErrorState } from '@/components/ui';
import { SalesApi, type Lead } from '@/features/sales/api';
import { fmtRelative } from '@/lib/format';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function LeadsList() {
  const [seg, setSeg] = useState<'retail' | 'corporate'>('retail');
  const router = useRouter();

  const retail = useQuery({ queryKey: ['leads', 'retail'], queryFn: () => SalesApi.retailLeads(), enabled: seg === 'retail' });
  const corporate = useQuery({ queryKey: ['leads', 'corporate'], queryFn: () => SalesApi.corporateLeads(), enabled: seg === 'corporate' });
  const active = seg === 'retail' ? retail : corporate;
  // Retail endpoint returns { leads }, corporate returns { data } — handle both.
  const rows: Lead[] = (active.data as any)?.leads ?? active.data?.data ?? [];

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={styles.headRow}>
          <Txt variant="title">Leads</Txt>
          <Pressable onPress={() => router.push(`/(app)/leads/new?type=${seg}`)}>
            <LinearGradient colors={neonGradient} style={styles.fab} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Ionicons name="add" size={24} color={colors.white} />
            </LinearGradient>
          </Pressable>
        </View>
        <SegmentedTabs
          segments={[{ key: 'retail', label: 'Retail' }, { key: 'corporate', label: 'Corporate' }]}
          active={seg}
          onChange={(k) => setSeg(k as any)}
        />
      </View>

      {active.isLoading ? (
        <Loading />
      ) : active.isError ? (
        <ErrorState message="Could not load leads" onRetry={active.refetch} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(l) => l.id}
          contentContainerStyle={styles.list}
          onRefresh={active.refetch}
          refreshing={active.isRefetching}
          ListEmptyComponent={<EmptyState icon="people-outline" title="No leads yet" subtitle="Tap + to create one." />}
          renderItem={({ item }) => (
            <GlassCard onPress={() => router.push(`/(app)/leads/${item.id}?type=${seg}`)}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Txt variant="heading" numberOfLines={1}>{item.customerName || 'Unnamed lead'}</Txt>
                  <Txt variant="muted">{item.customerPhone || item.phone || '—'} · {item.leadSource || '—'}</Txt>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' }}>
                    <Pill label={item.status || 'New'} />
                    <Txt variant="faint">{item.leadNo || ''}</Txt>
                  </View>
                </View>
                <Txt variant="faint">{fmtRelative(item.createdAt || item.submittedAt)}</Txt>
              </View>
            </GlassCard>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fab: { width: 44, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
});
