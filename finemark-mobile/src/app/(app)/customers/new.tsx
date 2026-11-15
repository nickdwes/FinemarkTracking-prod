import React, { useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Screen, GlassCard, Txt, Field, NeonButton, Sheet, Divider, toast } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import type { ApiError } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';

export default function NewCustomer() {
  const router = useRouter();
  const [type, setType] = useState<'individual' | 'corporate'>('individual');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupMatches, setDupMatches] = useState<any[]>([]);

  const buildBody = (override = false): Record<string, any> => ({
    type,
    region: region.trim() || undefined,
    source: 'Mobile',
    overrideDuplicate: override,
    ...(type === 'individual'
      ? { individual: { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined } }
      : { corporate: { companyName: company.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined } }),
  });

  const submit = async (override = false) => {
    if (type === 'individual' && !firstName.trim()) return toast.error('First name is required');
    if (type === 'corporate' && !company.trim()) return toast.error('Company name is required');
    setBusy(true);
    try {
      await SalesApi.registerCustomer(buildBody(override));
      toast.success('Customer registered');
      router.back();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409 && (err.code === 'DUPLICATE_CUSTOMER' || String(err.message).toLowerCase().includes('dupl'))) {
        setDupMatches(Array.isArray((err.details as any)?.matches) ? (err.details as any).matches : (err.details as any) || []);
        setDupOpen(true);
      } else {
        toast.error(err?.message || 'Could not register');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
        <Txt variant="heading">Register Customer</Txt>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.toggle}>
        {(['individual', 'corporate'] as const).map((t) => (
          <Pressable key={t} onPress={() => setType(t)} style={[styles.toggleBtn, type === t && styles.toggleOn]}>
            <Txt variant="body" weight="semibold" style={type === t ? { color: colors.cyan } : { color: colors.textMuted }}>
              {t === 'individual' ? 'Individual' : 'Corporate'}
            </Txt>
          </Pressable>
        ))}
      </View>

      <GlassCard style={{ marginTop: spacing.md }}>
        {type === 'individual' ? (
          <>
            <Field label="First name" value={firstName} onChangeText={setFirstName} required />
            <Field label="Last name" value={lastName} onChangeText={setLastName} />
          </>
        ) : (
          <Field label="Company name" value={company} onChangeText={setCompany} required />
        )}
        <Field label="Phone" placeholder="07…" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
        <Field label="Email" placeholder="name@example.com" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label="Region" placeholder="Nairobi" value={region} onChangeText={setRegion} />
      </GlassCard>

      <NeonButton label="Register customer" icon="person-add-outline" loading={busy} onPress={() => submit(false)} style={{ marginTop: spacing.lg }} />
      <Divider />

      <Sheet visible={dupOpen} onClose={() => setDupOpen(false)} title="Possible duplicate">
        <Txt variant="muted" style={{ marginBottom: spacing.md }}>
          A similar customer may already exist:
        </Txt>
        {dupMatches.slice(0, 5).map((m, i) => (
          <View key={i} style={styles.match}>
            <Ionicons name="person-outline" size={16} color={colors.amber} />
            <Txt variant="body" style={{ marginLeft: spacing.sm, flex: 1 }} numberOfLines={1}>
              {m.name || m.displayName || m.companyName || m.phone || 'Existing record'}
            </Txt>
          </View>
        ))}
        <NeonButton label="Register anyway" variant="subtle" loading={busy} onPress={() => { setDupOpen(false); submit(true); }} style={{ marginTop: spacing.md }} />
        <NeonButton label="Cancel" variant="ghost" onPress={() => setDupOpen(false)} style={{ marginTop: spacing.sm }} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggle: { flexDirection: 'row', backgroundColor: colors.glassStrong, borderRadius: radius.md, padding: 4, marginTop: spacing.lg },
  toggleBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.sm },
  toggleOn: { backgroundColor: colors.cyanDim },
  match: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
});
