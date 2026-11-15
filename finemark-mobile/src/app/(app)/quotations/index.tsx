import React, { useMemo, useState } from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { Screen, GlassCard, Txt, Pill, SegmentedTabs, Loading, EmptyState, ErrorState, type Segment } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { fmtKES, fmtRelative } from '@/lib/format';
import { colors, spacing } from '@/theme';

const SEGMENTS: (Segment & { match?: (q: any) => boolean })[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft', match: (q) => (q.status || '').toLowerCase() === 'draft' },
  { key: 'sent', label: 'Sent', match: (q) => (q.status || '').toLowerCase() === 'sent' },
  { key: 'accepted', label: 'Accepted', match: (q) => (q.status || '').toLowerCase() === 'accepted' },
  { key: 'rejected', label: 'Rejected', match: (q) => (q.status || '').toLowerCase() === 'rejected' },
  { key: 'superseded', label: 'Superseded', match: (q) => (q.status || '').toLowerCase() === 'superseded' },
];

export default function QuotationsList() {
  const router = useRouter();
  const [seg, setSeg] = useState('all');
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['quotes'],
    queryFn: () => SalesApi.quotes({ pageSize: '200' }),
  });

  const all = data?.data ?? [];
  const rows = useMemo(() => {
    const s = SEGMENTS.find((x) => x.key === seg);
    return s?.match ? all.filter(s.match) : all;
  }, [all, seg]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of SEGMENTS) m[s.key] = s.match ? all.filter(s.match).length : all.length;
    return m;
  }, [all]);

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Txt variant="title">Quotations</Txt>
        <SegmentedTabs
          segments={SEGMENTS.map((s) => ({ key: s.key, label: s.label, count: counts[s.key] }))}
          active={seg}
          onChange={setSeg}
        />
      </View>

      {isLoading ? (
        <Loading label="Loading quotations…" />
      ) : isError ? (
        <ErrorState message="Could not load quotations" onRetry={refetch} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(q) => q.id}
          contentContainerStyle={styles.list}
          onRefresh={refetch}
          refreshing={isRefetching}
          ListEmptyComponent={<EmptyState icon="document-text-outline" title="No quotations" subtitle="Quotes you raise appear here." />}
          renderItem={({ item }) => (
            <GlassCard onPress={() => router.push(`/(app)/quotations/${item.id}`)}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Txt variant="mono" weight="bold" color={colors.cyan}>{item.quoteNo || item.id?.slice(0, 8)}</Txt>
                  <Txt variant="heading" numberOfLines={1} style={{ marginTop: 2 }}>{item.customerName || 'Customer'}</Txt>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' }}>
                    <Pill label={item.status || 'Draft'} />
                    <Txt variant="faint">{fmtRelative(item.createdAt)}</Txt>
                  </View>
                </View>
                <Txt variant="mono" weight="bold" color={colors.text}>{fmtKES(item.totalAmount ?? item.total_amount)}</Txt>
              </View>
            </GlassCard>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
});
