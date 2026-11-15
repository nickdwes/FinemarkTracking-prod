import React, { useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { Screen, GlassCard, Txt, Field, Loading, EmptyState, ErrorState } from '@/components/ui';
import { SalesApi, type Customer } from '@/features/sales/api';
import { initials } from '@/lib/format';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function CustomersList() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const term = search.trim();
  const q = useQuery({
    queryKey: ['customers', term],
    // 2+ chars → name / phone / vehicle-reg search; otherwise the full list.
    queryFn: () => (term.length >= 2 ? SalesApi.searchCustomers(term) : SalesApi.customers()),
  });
  const rows: Customer[] = q.data?.data ?? [];

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={styles.headRow}>
          <Txt variant="title">Customers</Txt>
          <Pressable onPress={() => router.push('/(app)/customers/new')}>
            <LinearGradient colors={neonGradient} style={styles.fab} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <Ionicons name="person-add" size={20} color={colors.white} />
            </LinearGradient>
          </Pressable>
        </View>
        <Field placeholder="Search name, phone or vehicle reg…" value={search} onChangeText={setSearch} autoCapitalize="none" />
      </View>

      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState message="Could not load customers" onRetry={q.refetch} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.list}
          onRefresh={q.refetch}
          refreshing={q.isRefetching}
          ListEmptyComponent={<EmptyState icon="person-outline" title="No customers" subtitle="Register one with the + button." />}
          renderItem={({ item }) => (
            <GlassCard onPress={() => router.push(`/(app)/customers/${item.id}`)}>
              <View style={styles.row}>
                <View style={styles.avatar}><Txt variant="body" weight="bold" color={colors.cyan}>{initials(item.name || item.displayName)}</Txt></View>
                <View style={{ flex: 1 }}>
                  <Txt variant="heading" numberOfLines={1}>{item.name || item.displayName || 'Customer'}</Txt>
                  <Txt variant="muted">{item.type || 'individual'}{item.region ? ` · ${item.region}` : ''}</Txt>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </View>
            </GlassCard>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  fab: { width: 44, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.cyanDim, alignItems: 'center', justifyContent: 'center' },
});
