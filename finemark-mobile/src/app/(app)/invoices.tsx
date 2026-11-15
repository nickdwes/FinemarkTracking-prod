import React, { useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { Screen, GlassCard, Txt, Pill, Field, NeonButton, Sheet, Divider, KeyValue, Loading, EmptyState, ErrorState, toast } from '@/components/ui';
import { FinanceApi, PAYMENT_METHODS, type Invoice } from '@/features/finance/api';
import { fmtKES, fmtDate } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';

export default function InvoicesScreen() {
  const qc = useQueryClient();
  const summaryQ = useQuery({ queryKey: ['finance', 'summary'], queryFn: () => FinanceApi.summary() });
  const invoicesQ = useQuery({ queryKey: ['finance', 'invoices'], queryFn: () => FinanceApi.invoices() });
  const [active, setActive] = useState<Invoice | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('M-Pesa');
  const [ref, setRef] = useState('');

  const s = summaryQ.data;
  const rows = invoicesQ.data?.data ?? [];

  const pay = useMutation({
    mutationFn: (body: Record<string, any>) => FinanceApi.recordPayment(body),
    onSuccess: () => {
      toast.success('Payment recorded');
      setActive(null);
      setAmount('');
      setRef('');
      qc.invalidateQueries({ queryKey: ['finance'] });
    },
    onError: (e: ApiError) => toast.error(e?.message || 'Failed to record'),
  });

  const amountOf = (i: Invoice) => i.balance ?? i.totalAmount ?? i.total ?? 0;

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Txt variant="title">Invoices</Txt>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        onRefresh={() => { summaryQ.refetch(); invoicesQ.refetch(); }}
        refreshing={invoicesQ.isRefetching}
        ListHeaderComponent={
          <View style={{ gap: spacing.md, marginBottom: spacing.md }}>
            <GlassCard neon>
              <Txt variant="label">Accounts receivable</Txt>
              <View style={styles.statsRow}>
                <View style={styles.stat}>
                  <Txt variant="mono" weight="bold" style={{ fontSize: 22, color: colors.amber }}>{s ? fmtKES(s.outstanding) : '—'}</Txt>
                  <Txt variant="faint">Outstanding</Txt>
                </View>
                <View style={styles.stat}>
                  <Txt variant="mono" weight="bold" style={{ fontSize: 22, color: colors.green }}>{s ? fmtKES(s.thisMonthRevenue) : '—'}</Txt>
                  <Txt variant="faint">This month</Txt>
                </View>
              </View>
            </GlassCard>
            {invoicesQ.isLoading ? <Loading /> : invoicesQ.isError ? <ErrorState message="Could not load invoices" onRetry={invoicesQ.refetch} /> : null}
          </View>
        }
        ListEmptyComponent={!invoicesQ.isLoading ? <EmptyState icon="receipt-outline" title="No invoices" /> : null}
        renderItem={({ item }) => (
          <GlassCard onPress={() => { setActive(item); setAmount(String(amountOf(item) || '')); }}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Txt variant="heading" numberOfLines={1}>{item.customerName || 'Customer'}</Txt>
                <Txt variant="faint">{item.invoiceNo || item.number || item.id.slice(0, 8)} · due {fmtDate(item.dueDate)}</Txt>
                <View style={{ marginTop: spacing.sm, flexDirection: 'row' }}><Pill label={item.status || 'Unpaid'} /></View>
              </View>
              <Txt variant="mono" weight="bold" color={colors.cyan}>{fmtKES(amountOf(item))}</Txt>
            </View>
          </GlassCard>
        )}
      />

      <Sheet visible={!!active} onClose={() => setActive(null)} title="Invoice">
        {active ? (
          <>
            <KeyValue label="Customer" value={active.customerName} />
            <KeyValue label="Invoice" value={active.invoiceNo || active.number || active.id.slice(0, 8)} />
            <KeyValue label="Total" value={fmtKES(active.totalAmount ?? active.total)} />
            <KeyValue label="Balance" value={fmtKES(amountOf(active))} />
            <KeyValue label="Status" value={active.status} />
            <Divider />
            <Txt variant="label" style={{ marginBottom: spacing.sm }}>Record payment</Txt>
            <Field label="Amount (KES)" keyboardType="numeric" value={amount} onChangeText={setAmount} required />
            <Txt variant="label" style={{ marginBottom: spacing.sm }}>Method</Txt>
            <View style={styles.chips}>
              {PAYMENT_METHODS.map((m) => (
                <Pressable key={m} onPress={() => setMethod(m)} style={[styles.chip, method === m && styles.chipOn]}>
                  <Txt variant="muted" style={method === m ? { color: colors.cyan } : undefined}>{m}</Txt>
                </Pressable>
              ))}
            </View>
            <Field label="Reference" placeholder="e.g. M-Pesa code" value={ref} onChangeText={setRef} />
            <NeonButton label="Record payment" icon="cash-outline" loading={pay.isPending}
              onPress={() => {
                const amt = parseFloat(amount);
                if (!amt || amt <= 0) return toast.error('Enter a valid amount');
                pay.mutate({ invoiceId: active.id, amount: amt, currency: 'KES', method, paymentRef: ref.trim() || undefined, paidAt: new Date().toISOString() });
              }} style={{ marginTop: spacing.md }} />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md, flexGrow: 1 },
  statsRow: { flexDirection: 'row', marginTop: spacing.md },
  stat: { flex: 1, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.glassStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder },
  chipOn: { backgroundColor: colors.cyanDim, borderColor: colors.glassBorderNeon },
});
