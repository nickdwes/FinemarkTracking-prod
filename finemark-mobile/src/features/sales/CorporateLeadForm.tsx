import React, { useMemo, useState } from 'react';
import { View, StyleSheet, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import DateTimePicker from '@react-native-community/datetimepicker';

import { Screen, GlassCard, Txt, Field, Select, NeonButton, Divider, toast, type Option } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { fmtDate } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { colors, spacing } from '@/theme';

// 'bank partnership' intentionally omitted — crm-leads.ts requires a partnerId whenever
// this source is chosen, and there's no partner-picker UI wired into this form yet.
// Re-add once a partner picker ships here.
const CORPORATE_SOURCES = ['Direct', 'Referral', 'Tender', 'Digital'].map((v) => ({ label: v, value: v }));

export function CorporateLeadForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [address, setAddress] = useState('');
  const [source, setSource] = useState<string | null>('Direct');
  const [branch, setBranch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [expectedClose, setExpectedClose] = useState<Date>(() => new Date(Date.now() + 14 * 864e5));
  const [showDate, setShowDate] = useState(false);
  const [busy, setBusy] = useState(false);

  const isBank = (source || '').toLowerCase().includes('bank');

  // Mirrors RetailLeadForm's category picker — same categories endpoint.
  const catsQ = useQuery({ queryKey: ['catalogCategories'], queryFn: () => SalesApi.catalogCategories() });
  const categoryOpts: Option[] = useMemo(
    () => (catsQ.data?.data ?? []).map((c: any) => ({ label: c.name, value: c.id })),
    [catsQ.data],
  );

  const submit = async () => {
    if (!name.trim()) return toast.error('Customer name is required');
    if (!phone.trim() && !email.trim()) return toast.error('Add a phone or email');
    if (!source) return toast.error('Lead source is required');
    // Backend (crm-leads.ts) unconditionally requires this — unlike the retail form,
    // there's no "Other" text fallback here, an actual category id must be chosen.
    if (!categoryId) return toast.error('A product category of interest is required');
    setBusy(true);
    try {
      await SalesApi.createCorporateLead({
        leadSource: source,
        leadDate: new Date().toISOString(),
        expectedCloseDate: expectedClose.toISOString(),
        customerType: 'new_customer',
        customerName: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        companyName: company.trim() || undefined,
        bankPartnerBranch: isBank ? branch.trim() || undefined : undefined,
        address: address.trim() || undefined,
        productCategoryId: categoryId,
        productCategoryName: categoryOpts.find((o) => o.value === categoryId)?.label || undefined,
      });
      toast.success('Corporate lead created');
      router.back();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not create lead');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
        <Txt variant="heading">New Corporate Lead</Txt>
        <View style={{ width: 24 }} />
      </View>

      <GlassCard style={{ marginTop: spacing.md }}>
        <Select label="Lead source" required value={source} options={CORPORATE_SOURCES} onChange={setSource} />
        {isBank ? <Field label="Branch" placeholder="e.g. Westlands" value={branch} onChangeText={setBranch} hint="Shown because a bank partnership was chosen" /> : null}
      </GlassCard>

      <GlassCard style={{ marginTop: spacing.md }}>
        <Select label="Product category of interest" required value={categoryId} options={categoryOpts} loading={catsQ.isLoading}
          onChange={setCategoryId} placeholder="— Select category —" />
      </GlassCard>

      <GlassCard style={{ marginTop: spacing.md }}>
        <Field label="Customer name" required placeholder="Full name" value={name} onChangeText={setName} />
        <Field label="Phone" placeholder="07…" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
        <Field label="Email" placeholder="name@example.com" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label="Company" placeholder="Company name" value={company} onChangeText={setCompany} />
        <Field label="Address" placeholder="Town / area" value={address} onChangeText={setAddress} />
      </GlassCard>

      <GlassCard style={{ marginTop: spacing.md }}>
        <Txt variant="label" style={{ marginBottom: spacing.sm }}>Expected close date</Txt>
        <Pressable style={styles.dateBtn} onPress={() => setShowDate(true)}>
          <Ionicons name="calendar-outline" size={18} color={colors.cyan} />
          <Txt variant="body" style={{ marginLeft: spacing.sm }}>{fmtDate(expectedClose.toISOString())}</Txt>
        </Pressable>
        {showDate ? (
          <DateTimePicker value={expectedClose} mode="date" minimumDate={new Date()}
            onChange={(_, d) => { setShowDate(Platform.OS === 'ios'); if (d) setExpectedClose(d); }} />
        ) : null}
      </GlassCard>

      <NeonButton label="Create lead" icon="add-circle-outline" loading={busy} onPress={submit} style={{ marginTop: spacing.lg }} />
      <Divider />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  dateBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, borderRadius: 12, padding: spacing.md,
  },
});
