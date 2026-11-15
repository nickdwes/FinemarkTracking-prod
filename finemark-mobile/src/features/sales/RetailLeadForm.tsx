import React, { useMemo, useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';

import { Screen, GlassCard, Txt, Field, Select, NeonButton, Divider, toast, type Option } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { useAuth } from '@/features/auth/authStore';
import {
  RETAIL_LEAD_SOURCES, PARTNERSHIP_SOURCES, INSTALLATION_FINANCERS,
  VEHICLE_CATEGORIES, VEHICLE_COLORS, KE_COUNTIES,
} from '@/constants/leadOptions';
import { isValidEmail, isValidKePhone, isValidKeRegistration } from '@/lib/validators';
import type { ApiError } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';

const OTHER_CAT = '__other__';

/** Radio row (registered/not, individual/corporate, new/existing). */
function Choice<T extends string>({ label, value, onChange, options }: { label?: string; value: T; onChange: (v: T) => void; options: { label: string; value: T }[] }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Txt variant="label" style={{ marginBottom: 6 }}>{label}</Txt> : null}
      <View style={styles.choiceRow}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={o.value} onPress={() => onChange(o.value)} style={[styles.choiceBtn, on && styles.choiceOn]}>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={16} color={on ? colors.cyan : colors.textFaint} />
              <Txt variant="body" style={{ marginLeft: 8, color: on ? colors.cyan : colors.textMuted }}>{o.label}</Txt>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <GlassCard style={{ marginBottom: spacing.md }}>
      <Txt variant="heading" style={{ marginBottom: spacing.md }}>{title}</Txt>
      {children}
    </GlassCard>
  );
}

export function RetailLeadForm() {
  const router = useRouter();
  const user = useAuth((s) => s.user);

  // Section 1 — customer type
  const [customerType, setCustomerType] = useState<'new_customer' | 'existing_customer'>('new_customer');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState<any[]>([]);

  // Section 2 — source & partner
  const [leadSource, setLeadSource] = useState<string | null>(null);
  const [primaryPartner, setPrimaryPartner] = useState<string | null>(null);
  const [secondaryPartner, setSecondaryPartner] = useState<string | null>(null);
  const [bankBranch, setBankBranch] = useState('');
  const [financer, setFinancer] = useState<string | null>(null);
  const [referrerName, setReferrerName] = useState('');
  const [referrerPhone, setReferrerPhone] = useState('');
  const [referrerCommission, setReferrerCommission] = useState('');

  // Section 3 — product
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [productOther, setProductOther] = useState('');

  // Section 4 — customer details
  const [entityType, setEntityType] = useState<'individual' | 'corporate'>('individual');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [county, setCounty] = useState<string | null>(null);
  const [customerNotes, setCustomerNotes] = useState('');

  // Section 5 — vehicle
  const [regStatus, setRegStatus] = useState<'registered' | 'not_registered'>('registered');
  const [vehicleReg, setVehicleReg] = useState('');
  const [vehicleCategory, setVehicleCategory] = useState<string>('motor_vehicle');
  const [vehicleMake, setVehicleMake] = useState<string | null>(null);
  const [vehicleModel, setVehicleModel] = useState<string | null>(null);
  const [vehicleYear, setVehicleYear] = useState('');
  const [vehicleColor, setVehicleColor] = useState<string | null>(null);
  const [vehicleEngine, setVehicleEngine] = useState('');
  const [vehicleChassis, setVehicleChassis] = useState('');
  const [loanTerm, setLoanTerm] = useState('');

  // Section 6 — location & installation
  const [locationName, setLocationName] = useState('');
  const [installCounty, setInstallCounty] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [locationDesc, setLocationDesc] = useState('');
  const [locationNotes, setLocationNotes] = useState('');

  const [busy, setBusy] = useState<null | 'draft' | 'submit'>(null);

  // ── Dropdown data ──────────────────────────────────────────────────────
  const partnersQ = useQuery({ queryKey: ['partners'], queryFn: () => SalesApi.partners() });
  const catsQ = useQuery({ queryKey: ['catalogCategories'], queryFn: () => SalesApi.catalogCategories() });
  const productsQ = useQuery({ queryKey: ['catalogProducts'], queryFn: () => SalesApi.catalogProducts() });
  const makesQ = useQuery({ queryKey: ['vehMakes', vehicleCategory], queryFn: () => SalesApi.vehicleMakes(vehicleCategory) });
  // Some categories (Special Equipment, Fabricated Body, Trailers, Special Cargo) carry
  // no make/model catalog at all — once the makes lookup has actually returned empty for
  // the selected category, fall back to free-text Make/Model instead of a dead-end Select.
  const noMakeCatalog = !makesQ.isLoading && !makesQ.isFetching && (makesQ.data?.data?.length ?? 0) === 0;
  const modelsQ = useQuery({
    queryKey: ['vehModels', vehicleMake, vehicleCategory],
    queryFn: () => SalesApi.vehicleModels(vehicleMake!, vehicleCategory),
    enabled: !!vehicleMake && !noMakeCatalog,
  });

  const partnerOpts: Option[] = useMemo(
    () => (partnersQ.data?.data ?? []).map((p: any) => ({ label: p.name || p.partnerName || p.id, value: p.id })),
    [partnersQ.data],
  );
  const categoryOpts: Option[] = useMemo(
    () => [...(catsQ.data?.data ?? []).map((c: any) => ({ label: c.name, value: c.id })), { label: 'Other', value: OTHER_CAT }],
    [catsQ.data],
  );
  const productOpts: Option[] = useMemo(() => {
    const all = (productsQ.data?.data ?? []).map((p: any) => ({
      id: p.id, name: p.product_name || p.productName || p.name || '', categoryId: p.category_id || p.categoryId || null,
    }));
    const filtered = categoryId && categoryId !== OTHER_CAT ? all.filter((p) => p.categoryId === categoryId) : all;
    return [...filtered.map((p) => ({ label: p.name, value: p.id })), { label: 'Other', value: OTHER_CAT }];
  }, [productsQ.data, categoryId]);
  const makeOpts: Option[] = useMemo(() => (makesQ.data?.data ?? []).map((m) => ({ label: m, value: m })), [makesQ.data]);
  const modelOpts: Option[] = useMemo(() => (modelsQ.data?.data ?? []).map((m) => ({ label: m.model, value: m.model })), [modelsQ.data]);

  const isPartnership = leadSource ? PARTNERSHIP_SOURCES.includes(leadSource) : false;
  // Matches backend's requiresBank (retail-leads.ts) and web's isBankContext(): a lead is
  // "bank context" via the Bank Partnership source OR a Bank Financed installation financer —
  // either one alone must reveal the partner/branch/loan-term fields the backend requires.
  const isBank = leadSource === 'Bank Partnership' || financer === 'Bank Financed';
  const isRegistered = regStatus === 'registered';
  const categoryIsOther = categoryId === OTHER_CAT;
  const productIsOther = productId === OTHER_CAT;
  const categoryLabel = categoryId && !categoryIsOther ? categoryOpts.find((o) => o.value === categoryId)?.label ?? null : null;

  const doSearchCustomers = async () => {
    if (!custSearch.trim()) return;
    try {
      const r = await SalesApi.searchCustomers(custSearch.trim());
      setCustResults(r.data ?? []);
    } catch (e: any) {
      toast.error(e?.message || 'Search failed');
    }
  };

  const buildPayload = () => {
    const partnerName = primaryPartner ? partnerOpts.find((o) => o.value === primaryPartner)?.label : null;
    const secondaryPartnerName = secondaryPartner ? partnerOpts.find((o) => o.value === secondaryPartner)?.label : null;
    const loanTermMonths = parseInt(loanTerm, 10);
    return {
      customerType,
      customerEntityType: entityType,
      leadSource,
      partnerId: primaryPartner || null,
      partnerName,
      secondaryPartnerId: secondaryPartner || null,
      secondaryPartnerName,
      referrerName: referrerName.trim() || null,
      referrerPhone: referrerPhone.trim() || null,
      referrerCommission: referrerCommission.trim() ? Number(referrerCommission) : null,
      bdmId: user?.id || null,
      bdmName: user?.name || user?.email || null,
      productId: productId && !productIsOther ? productId : null,
      productName: productId && !productIsOther ? productOpts.find((o) => o.value === productId)?.label : null,
      productOther: categoryIsOther || productIsOther ? productOther.trim() || null : null,
      // Required by backend on every create (draft or submit) — was previously
      // omitted entirely, guaranteeing a 400 "A product category of interest is
      // required." on every retail lead.
      productCategoryId: categoryId && !categoryIsOther ? categoryId : null,
      productCategoryName: categoryIsOther ? (productOther.trim() || 'Other') : categoryLabel,
      customerId: customerId || null,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim() || null,
      customerEmail: customerEmail.trim() || null,
      customerLocation: county || null,
      customerNotes: customerNotes.trim() || null,
      installationFinancer: financer || null,
      bankPartnerName: isBank && primaryPartner ? partnerName : null,
      bankPartnerBranch: isBank ? bankBranch.trim() || null : null,
      vehicle: {
        registrationKnown: isRegistered,
        registration: vehicleReg.trim().toUpperCase() || null,
        chassisNo: vehicleChassis.trim().toUpperCase() || null,
        vehicleCategory,
        make: vehicleMake?.trim() || null,
        model: vehicleModel?.trim() || null,
        year: vehicleYear.trim() || null,
        color: vehicleColor || null,
        engineNo: vehicleEngine.trim() || null,
        loanTermMonths: loanTermMonths > 0 ? loanTermMonths : null,
      },
      locationName: locationName.trim() || null,
      locationNotes: locationNotes.trim() || null,
      installationContactName: contactName.trim() || null,
      installationContactPhone: contactPhone.trim() || null,
      installationCounty: installCounty || null,
      locationDescription: locationDesc.trim() || null,
    };
  };

  const validate = (): string | null => {
    if (!customerName.trim()) return 'Customer name is required.';
    if (!leadSource) return 'Lead source is required.';
    if (!categoryId) return 'Product category is required.';
    if (categoryIsOther && !productOther.trim()) return 'Please describe the product category.';
    if (isBank && !primaryPartner) return 'A primary partner is required for a Bank Partnership lead.';
    if (isBank && !(parseInt(loanTerm, 10) > 0)) return 'A loan term (months) is required for a bank-financed lead.';
    if (referrerPhone.trim() && !isValidKePhone(referrerPhone)) return 'Referrer phone is invalid.';
    if (referrerCommission.trim() && (isNaN(Number(referrerCommission)) || Number(referrerCommission) < 0)) return 'Referrer commission must be a valid amount.';
    if (customerPhone.trim() && !isValidKePhone(customerPhone)) return 'Customer phone is invalid.';
    if (customerEmail.trim() && !isValidEmail(customerEmail)) return 'Customer email is invalid.';
    if (!isRegistered && !vehicleChassis.trim()) return 'Chassis number is required for unregistered vehicles.';
    if (isRegistered && !vehicleReg.trim()) return 'Vehicle registration is required for registered vehicles.';
    if (isRegistered && vehicleReg.trim() && !isValidKeRegistration(vehicleReg)) return 'Vehicle registration format is invalid (e.g. KCA 123A).';
    if (!locationName.trim()) return 'Location / Partner Yard Name is required.';
    if (!contactName.trim()) return 'Installation contact name is required.';
    if (!contactPhone.trim()) return 'Installation contact phone is required.';
    if (!isValidKePhone(contactPhone)) return 'Installation contact phone is invalid.';
    return null;
  };

  const save = async (mode: 'draft' | 'submit') => {
    if (mode === 'draft') {
      if (!customerName.trim()) return toast.error('Customer name is required to save a draft.');
      if (!leadSource) return toast.error('Lead source is required.');
      // Backend requires this on every create, draft or submit — same endpoint.
      if (!categoryId) return toast.error('Product category is required.');
      if (categoryIsOther && !productOther.trim()) return toast.error('Please describe the product category.');
    } else {
      const err = validate();
      if (err) return toast.error(err);
    }
    setBusy(mode);
    try {
      const res: any = await SalesApi.createRetailLead(buildPayload());
      const lead = res?.lead || res?.data || res;
      const leadId = lead?.id;
      if (mode === 'submit' && leadId) {
        // locationName is required by the submit endpoint and is NOT persisted on the
        // lead row — it must be forwarded here from the form state already on screen.
        await SalesApi.submitRetail(leadId, {
          locationName: locationName.trim(),
          locationNotes: locationNotes.trim() || undefined,
        });
        toast.success(`Lead submitted — ${lead?.leadNo || ''} · ticket created`);
      } else {
        toast.success(`Draft saved — ${lead?.leadNo || 'lead created'}`);
      }
      router.back();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not save lead');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen scroll>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
        <Txt variant="heading">New Retail Lead</Txt>
        <View style={{ width: 24 }} />
      </View>

      {/* 1 — Customer type */}
      <Section title="Customer">
        <Choice label="Customer type" value={customerType} onChange={setCustomerType}
          options={[{ label: 'New customer', value: 'new_customer' }, { label: 'Existing customer', value: 'existing_customer' }]} />
        {customerType === 'existing_customer' ? (
          <View>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <View style={{ flex: 1 }}><Field placeholder="Search name or phone…" value={custSearch} onChangeText={setCustSearch} /></View>
              <NeonButton label="Search" variant="ghost" full={false} onPress={doSearchCustomers} style={{ height: 48 }} />
            </View>
            {custResults.map((c) => {
              const name = c.displayName || c.name || c.companyName || c.customerName || '—';
              return (
                <Pressable key={c.id} style={styles.custResult}
                  onPress={() => { setCustomerId(c.id); setCustomerName(name); setCustResults([]); setCustSearch(name); }}>
                  <Txt variant="body">{name}</Txt>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Section>

      {/* 2 — Source & partner */}
      <Section title="Lead Source & Partner">
        <Select label="Lead source" required value={leadSource} options={RETAIL_LEAD_SOURCES} onChange={setLeadSource} placeholder="— Select lead source —" />
        {/* Also shown for a Bank Financed installation financer even when the lead source
            itself isn't a partnership — that combination is bank context too (see isBank)
            and the backend requires a partner bank to be nameable either way. */}
        {(isPartnership || isBank) ? (
          <>
            <Select label="Primary partner" required={isBank} value={primaryPartner} options={partnerOpts} loading={partnersQ.isLoading} searchable
              onChange={setPrimaryPartner} placeholder="— Select primary partner —" />
            <Select label="Secondary partner" value={secondaryPartner} options={partnerOpts} loading={partnersQ.isLoading} searchable
              onChange={setSecondaryPartner} placeholder="— Select secondary partner —" />
            {partnersQ.isError ? (
              <Txt variant="faint" style={{ color: colors.red, marginTop: -spacing.sm, marginBottom: spacing.md }}>
                Couldn’t load partners: {(partnersQ.error as ApiError)?.status === 403 ? 'your role lacks access to the partner list.' : (partnersQ.error as ApiError)?.message || 'try again.'}
              </Txt>
            ) : !partnersQ.isLoading && partnerOpts.length === 0 ? (
              <Txt variant="faint" style={{ marginTop: -spacing.sm, marginBottom: spacing.md }}>
                No partners found.
              </Txt>
            ) : null}
          </>
        ) : null}
        {isBank ? (
          <Field label="Branch" placeholder="e.g. Westlands, Mombasa Road" value={bankBranch} onChangeText={setBankBranch}
            hint="Shown because a bank partnership was chosen" />
        ) : null}
        <Select label="Installation financer" value={financer} options={INSTALLATION_FINANCERS} onChange={setFinancer} placeholder="— Select financer —" />
        <Field label="Referrer name" placeholder="Full name of referrer" value={referrerName} onChangeText={setReferrerName} />
        <Field label="Referrer phone" placeholder="+254 7XX XXX XXX" keyboardType="phone-pad" value={referrerPhone} onChangeText={setReferrerPhone} />
        <Field
          label="Referrer commission (KES)"
          placeholder="e.g. 2000"
          keyboardType="decimal-pad"
          value={referrerCommission}
          onChangeText={setReferrerCommission}
          hint="Proposed payout — pre-filled during payment processing so the referrer & amount are ready when the commission is paid."
        />
      </Section>

      {/* 3 — Product interest */}
      <Section title="Product Interest">
        <Select label="Product category" required value={categoryId} options={categoryOpts} loading={catsQ.isLoading}
          onChange={(v) => { setCategoryId(v); setProductId(null); }} placeholder="— Select category —" />
        {!categoryIsOther ? (
          <Select label="Specific product" value={productId} options={productOpts} loading={productsQ.isLoading} searchable
            onChange={setProductId} placeholder="— Select product (optional) —" />
        ) : null}
        {categoryIsOther || productIsOther ? (
          <Field label="Describe product / suggestion" placeholder="Describe the product…" value={productOther} onChangeText={setProductOther} />
        ) : null}
      </Section>

      {/* 4 — Customer details */}
      <Section title="Customer Details">
        <Choice label="Entity type" value={entityType} onChange={setEntityType}
          options={[{ label: 'Individual', value: 'individual' }, { label: 'Corporate', value: 'corporate' }]} />
        <Field label="Full customer name / company" required placeholder="Full legal name or company" value={customerName} onChangeText={setCustomerName} />
        <Field label="Phone number" placeholder="+254 7XX XXX XXX" keyboardType="phone-pad" value={customerPhone} onChangeText={setCustomerPhone} />
        <Field label="Email address" placeholder="customer@example.com" autoCapitalize="none" keyboardType="email-address" value={customerEmail} onChangeText={setCustomerEmail} />
        <Select label="Customer location (county)" value={county} options={KE_COUNTIES} searchable onChange={setCounty} placeholder="— Select county —" />
        <Field label="Notes" placeholder="Additional notes…" value={customerNotes} onChangeText={setCustomerNotes} multiline numberOfLines={3} style={{ minHeight: 76, textAlignVertical: 'top' }} />
      </Section>

      {/* 5 — Vehicle */}
      <Section title="Vehicle">
        <Choice label="Registration status" value={regStatus} onChange={setRegStatus}
          options={[{ label: 'Registered', value: 'registered' }, { label: 'Not registered', value: 'not_registered' }]} />
        <Field label={isRegistered ? 'Registration *' : 'Registration (optional)'} placeholder="e.g. KCA 123A" autoCapitalize="characters"
          value={vehicleReg} onChangeText={setVehicleReg} />
        <Select label="Category" value={vehicleCategory} options={VEHICLE_CATEGORIES}
          onChange={(v) => { setVehicleCategory(v); setVehicleMake(null); setVehicleModel(null); }} />
        {noMakeCatalog ? (
          <Field label="Make" placeholder="Enter make" hint="No catalog for this category — type it in"
            value={vehicleMake ?? ''} onChangeText={(v) => { setVehicleMake(v); setVehicleModel(null); }} />
        ) : (
          <Select label="Make" value={vehicleMake} options={makeOpts} loading={makesQ.isLoading} searchable
            onChange={(v) => { setVehicleMake(v); setVehicleModel(null); }} placeholder="— Select make —" />
        )}
        {noMakeCatalog ? (
          <Field label="Model" placeholder="Enter model" value={vehicleModel ?? ''} onChangeText={setVehicleModel} />
        ) : (
          <Select label="Model" value={vehicleModel} options={modelOpts} loading={modelsQ.isFetching} searchable disabled={!vehicleMake}
            onChange={setVehicleModel} placeholder={vehicleMake ? '— Select model —' : '— Select make first —'} />
        )}
        <Field label="Year" placeholder="e.g. 2020" keyboardType="number-pad" value={vehicleYear} onChangeText={setVehicleYear} />
        <Select label="Color" value={vehicleColor} options={VEHICLE_COLORS} onChange={setVehicleColor} placeholder="— Select color —" />
        <Field label="Engine number" placeholder="Engine number" value={vehicleEngine} onChangeText={setVehicleEngine} />
        <Field label={isRegistered ? 'VIN / Chassis number' : 'VIN / Chassis number *'} placeholder="17-digit VIN / chassis" autoCapitalize="characters"
          value={vehicleChassis} onChangeText={setVehicleChassis} />
        <Field label={isBank ? 'Loan term (months) *' : 'Loan term (months)'} placeholder="0" keyboardType="number-pad" value={loanTerm} onChangeText={setLoanTerm}
          hint={isBank ? 'Required for a bank-financed lead' : '0 or blank = none'} />
      </Section>

      {/* 6 — Location & installation */}
      <Section title="Location & Installation">
        <Field label="Location / partner yard name" required placeholder="e.g. Equity Bank Westlands" value={locationName} onChangeText={setLocationName} />
        <Select label="County" value={installCounty} options={KE_COUNTIES} searchable onChange={setInstallCounty} placeholder="— Select county —" />
        <Field label="Installation contact name" required placeholder="Contact name on site" value={contactName} onChangeText={setContactName} />
        <Field label="Installation contact phone" required placeholder="+254 7XX XXX XXX" keyboardType="phone-pad" value={contactPhone} onChangeText={setContactPhone} />
        <Field label="Location description" placeholder="Landmarks, directions…" value={locationDesc} onChangeText={setLocationDesc} multiline numberOfLines={2} style={{ minHeight: 60, textAlignVertical: 'top' }} />
        <Field label="Instructions / notes for technician" placeholder="Access instructions…" value={locationNotes} onChangeText={setLocationNotes} multiline numberOfLines={2} style={{ minHeight: 60, textAlignVertical: 'top' }} />
      </Section>

      <NeonButton label="Submit lead & create ticket" icon="checkmark-done-outline" loading={busy === 'submit'} onPress={() => save('submit')} />
      <NeonButton label="Save as draft" variant="ghost" loading={busy === 'draft'} onPress={() => save('draft')} style={{ marginTop: spacing.sm }} />
      <Divider />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm, marginBottom: spacing.md },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choiceBtn: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.glassStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder,
  },
  choiceOn: { backgroundColor: colors.cyanDim, borderColor: colors.glassBorderNeon },
  custResult: { paddingVertical: 12, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.glassBorder },
});
