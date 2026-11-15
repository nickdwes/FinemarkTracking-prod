import React, { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen, Txt, SegmentedTabs, Loading, EmptyState, ErrorState, type Segment } from '@/components/ui';
import { JobCard } from '@/features/technical/JobCard';
import { useMyTickets } from '@/features/technical/hooks';
import type { Ticket } from '@/features/technical/api';
import { spacing } from '@/theme';

const SEGMENTS: (Segment & { match?: (t: Ticket) => boolean })[] = [
  { key: 'active', label: 'Active', match: (t) => !['Completed', 'Closed', 'Cancelled', 'Defaulted'].includes(t.status || '') },
  { key: 'assigned', label: 'Assigned', match: (t) => t.status === 'Assigned' || t.status === 'Pending' },
  { key: 'inprogress', label: 'In Progress', match: (t) => (t.status || '').replace(' ', '') === 'InProgress' },
  { key: 'hold', label: 'On Hold', match: (t) => ['On Hold', 'Rescheduled'].includes(t.status || '') },
  { key: 'done', label: 'Completed', match: (t) => ['Completed', 'Closed'].includes(t.status || '') },
  { key: 'all', label: 'All' },
];

export default function JobsList() {
  const [seg, setSeg] = useState('active');
  const router = useRouter();
  const { data, isLoading, isError, error, refetch, isRefetching } = useMyTickets();

  const tickets = data?.data ?? [];
  const filtered = useMemo(() => {
    const s = SEGMENTS.find((x) => x.key === seg);
    if (!s?.match) return tickets;
    return tickets.filter(s.match);
  }, [tickets, seg]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of SEGMENTS) map[s.key] = s.match ? tickets.filter(s.match).length : tickets.length;
    return map;
  }, [tickets]);

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Txt variant="title">My Jobs</Txt>
        <SegmentedTabs
          segments={SEGMENTS.map((s) => ({ key: s.key, label: s.label, count: counts[s.key] }))}
          active={seg}
          onChange={setSeg}
        />
      </View>

      {isLoading ? (
        <Loading label="Loading jobs…" />
      ) : isError ? (
        <ErrorState message={(error as any)?.message || 'Could not load jobs'} onRetry={refetch} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md }}
          renderItem={({ item }) => <JobCard ticket={item} onPress={() => router.push(`/(app)/jobs/${item.id}`)} />}
          onRefresh={refetch}
          refreshing={isRefetching}
          ListEmptyComponent={<EmptyState icon="checkmark-done-outline" title="No jobs here" subtitle="Nothing in this filter right now." />}
        />
      )}
    </Screen>
  );
}
