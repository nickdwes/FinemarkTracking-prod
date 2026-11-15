import React, { useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';

import { Screen, GlassCard, Txt, Pill, SegmentedTabs, Loading, ErrorState, EmptyState } from '@/components/ui';
import { SalesApi, type Lead } from '@/features/sales/api';
import { fmtRelative } from '@/lib/format';
import { colors, spacing } from '@/theme';

type LeadRow = Lead & { _kind: 'retail' | 'corporate' };

export default function RepLeads() {
  const { repId, repName } = useLocalSearchParams<{ repId: string; repName?: string }>();
  const router = useRouter();
  const [seg, setSeg] = useState<'all' | 'retail' | 'corporate'>('all');

  // A rep can have well over one page of leads (server caps pageSize at 200) —
  // page through until every lead is fetched instead of silently showing only
  // the first page, matching how the web CSV exports were fixed to do the same.
  const retail = useQuery({
    queryKey: ['repLeads', 'retail', repId],
    queryFn: async () => {
      const all: Lead[] = [];
      for (let page = 1; ; page++) {
        const res: any = await SalesApi.retailLeads({ salesRepId: repId!, page: String(page), pageSize: '200' });
        const rows: Lead[] = res.leads ?? res.data ?? [];
        all.push(...rows);
        if (all.length >= (res.total ?? rows.length) || rows.length === 0) break;
      }
      return { data: all };
    },
    enabled: !!repId,
  });
  const corporate = useQuery({
    queryKey: ['repLeads', 'corporate', repId],
    queryFn: async () => {
      const all: Lead[] = [];
      for (let page = 1; ; page++) {
        const res: any = await SalesApi.corporateLeads({ salesRepId: repId!, page: String(page), pageSize: '200' });
        const rows: Lead[] = res.data ?? [];
        all.push(...rows);
        if (all.length >= (res.meta?.total ?? rows.length) || rows.length === 0) break;
      }
      return { data: all };
    },
    enabled: !!repId,
  });

  const isLoading = retail.isLoading || corporate.isLoading;
  const isError = retail.isError || corporate.isError;
  const refetch = () => { retail.refetch(); corporate.refetch(); };
  const isRefetching = retail.isRefetching || corporate.isRefetching;

  const rows: LeadRow[] = useMemo(() => {
    const r: LeadRow[] = ((retail.data as any)?.data ?? []).map((l: Lead) => ({ ...l, _kind: 'retail' as const }));
    const c: LeadRow[] = ((corporate.data as any)?.data ?? []).map((l: Lead) => ({ ...l, _kind: 'corporate' as const }));
    const merged = seg === 'retail' ? r : seg === 'corporate' ? c : [...r, ...c];
    return merged.sort((a, b) => new Date(b.createdAt || b.submittedAt || 0).getTime() - new Date(a.createdAt || a.submittedAt || 0).getTime());
  }, [retail.data, corporate.data, seg]);

  const retailCount = ((retail.data as any)?.data ?? []).length;
  const corporateCount = ((corporate.data as any)?.data ?? []).length;

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={styles.headRow}>
          <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="chevron-back" size={24} color={colors.text} /></Pressable>
          <View style={{ flex: 1 }}>
            <Txt variant="title" numberOfLines={1}>{repName || 'Rep leads'}</Txt>
            <Txt variant="muted">{retailCount + corporateCount} lead{retailCount + corporateCount === 1 ? '' : 's'}</Txt>
          </View>
        </View>
        <SegmentedTabs
          segments={[
            { key: 'all', label: 'All' },
            { key: 'retail', label: `Retail (${retailCount})` },
            { key: 'corporate', label: `Corporate (${corporateCount})` },
          ]}
          active={seg}
          onChange={(k) => setSeg(k as any)}
        />
      </View>

      {isLoading ? (
        <Loading label="Loading leads…" />
      ) : isError ? (
        <ErrorState message="Could not load this rep's leads" onRetry={refetch} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(l) => `${l._kind}:${l.id}`}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          ListEmptyComponent={<EmptyState icon="people-outline" title="No leads" subtitle="This rep has no leads yet." />}
          renderItem={({ item }) => (
            <GlassCard onPress={() => router.push(`/(app)/leads/${item.id}?type=${item._kind}`)}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Txt variant="heading" numberOfLines={1}>{item.customerName || 'Unnamed lead'}</Txt>
                  <Txt variant="muted">{item.customerPhone || item.phone || '—'} · {item.leadSource || '—'}</Txt>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' }}>
                    <Pill label={item.status || 'New'} />
                    <Pill label={item._kind === 'retail' ? 'Retail' : 'Corporate'} />
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
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
});
