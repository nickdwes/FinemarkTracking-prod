import React, { useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';

import { Screen, GlassCard, Txt, Pill, KeyValue, Divider, IconChip, NeonButton, Field, Loading, ErrorState, toast } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { fmtDate } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { colors, spacing } from '@/theme';

const humanize = (s?: string | null) =>
  !s ? '—' : s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function LeadDetail() {
  const { id, type } = useLocalSearchParams<{ id: string; type: string }>();
  const isCorporate = type === 'corporate';
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  // Not persisted on the retail_leads row server-side, so a lead opened here (e.g. a
  // draft saved earlier) never has a location on record — collect it here before
  // submitting, same requirement RetailLeadForm satisfies from its own on-screen state.
  const [locationName, setLocationName] = useState('');
  const [locationNotes, setLocationNotes] = useState('');
  const [raising, setRaising] = useState(false);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['lead', type, id],
    queryFn: (): Promise<any> => (isCorporate ? SalesApi.corporateLead(id!) : SalesApi.retailLead(id!)),
    enabled: !!id,
  });

  if (isLoading) return <Screen><Loading label="Loading lead…" /></Screen>;
  if (isError) return <Screen><ErrorState message={(error as any)?.message || 'Could not load lead'} onRetry={refetch} /></Screen>;

  const lead: any = (data as any)?.lead ?? (data as any)?.data ?? {};
  const vehicles: any[] = lead.vehicles ?? (lead.vehicle ? [lead.vehicle] : []);
  const phone = lead.customerPhone || lead.phone;
  const email = lead.customerEmail || lead.email;
  const canSubmit = !isCorporate && !lead.installationTicketId && !['submitted', 'converted'].includes(String(lead.status || '').toLowerCase());
  // Mirrors retail-lead-detail.html's renderQuote(): bank/partner leads are
  // auto-quoted (quoteId set once the ticket's device is assigned); private /
  // non-partner leads are not, so a rep can raise one manually. Retail-only —
  // corporate leads have no quoting flow on either platform.
  const isPrivateLead = String(lead.bankPartnerName || '').trim().toLowerCase() === 'private' || !lead.partnerId;
  const canRaiseQuote = !isCorporate && !lead.quoteId && lead.status !== 'cancelled' && lead.status !== 'completed' && !!lead.installationTicketId;

  const raiseQuote = async () => {
    setRaising(true);
    try {
      const res = await SalesApi.raiseQuote(id!);
      const quote = res.data;
      toast.success(quote.pricingMissing ? 'Quotation raised — partner pricing not found, items at KES 0. Edit to set prices.' : 'Quotation raised.');
      qc.invalidateQueries({ queryKey: ['lead', type, id] });
      router.push(`/(app)/quotations/${quote.quoteId}?edit=1`);
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Failed to raise quote.');
    } finally {
      setRaising(false);
    }
  };

  const submit = async () => {
    if (!locationName.trim()) return toast.error('Location / Partner Yard Name is required before submission.');
    setSubmitting(true);
    try {
      await SalesApi.submitRetail(id!, { locationName: locationName.trim(), locationNotes: locationNotes.trim() || undefined });
      toast.success('Lead submitted — installation ticket created');
      qc.invalidateQueries({ queryKey: ['lead', type, id] });
      qc.invalidateQueries({ queryKey: ['leads'] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not submit');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen padded={false}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="chevron-back" size={24} color={colors.text} /></Pressable>
        <Txt variant="mono" weight="bold" color={colors.cyan}>{lead.leadNo || String(id).slice(0, 8)}</Txt>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.md }}
        showsVerticalScrollIndicator={false} refreshControl={undefined}>

        {/* Header / customer */}
        <GlassCard neon>
          <Txt variant="title" numberOfLines={2}>{lead.customerName || lead.companyName || 'Lead'}</Txt>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill label={humanize(lead.status)} />
            <Txt variant="faint">{isCorporate ? 'Corporate' : 'Retail'} · {lead.leadSource || '—'}</Txt>
          </View>
          {(phone || email) ? (
            <View style={styles.chips}>
              {phone ? <IconChip icon="call-outline" label="Call" onPress={() => Linking.openURL(`tel:${phone}`)} /> : null}
              {phone ? <IconChip icon="logo-whatsapp" label="WhatsApp" onPress={() => Linking.openURL(`https://wa.me/${String(phone).replace(/\D/g, '')}`)} /> : null}
              {email ? <IconChip icon="mail-outline" label="Email" onPress={() => Linking.openURL(`mailto:${email}`)} /> : null}
            </View>
          ) : null}
        </GlassCard>

        {/* Customer details */}
        <Section title="Customer">
          <KeyValue label="Name" value={lead.customerName} />
          {lead.companyName ? <KeyValue label="Company" value={lead.companyName} /> : null}
          <KeyValue label="Type" value={humanize(lead.customerEntityType || lead.customerType)} />
          <KeyValue label="Phone" value={phone} />
          <KeyValue label="Email" value={email} />
          <KeyValue label="Location" value={lead.customerLocation || lead.address} />
          {lead.customerNotes ? <KeyValue label="Notes" value={lead.customerNotes} /> : null}
        </Section>

        {/* Source & partner */}
        <Section title="Source & Partner">
          <KeyValue label="Lead source" value={lead.leadSource} />
          {lead.partnerName ? <KeyValue label="Primary partner" value={lead.partnerName} /> : null}
          {lead.secondaryPartnerName ? <KeyValue label="Secondary partner" value={lead.secondaryPartnerName} /> : null}
          {lead.bankPartnerName ? <KeyValue label="Bank partner" value={lead.bankPartnerName} /> : null}
          {lead.bankPartnerBranch ? <KeyValue label="Branch" value={lead.bankPartnerBranch} /> : null}
          {lead.installationFinancer ? <KeyValue label="Financer" value={lead.installationFinancer} /> : null}
          {lead.referrerName ? <KeyValue label="Referrer" value={`${lead.referrerName}${lead.referrerPhone ? ' · ' + lead.referrerPhone : ''}`} /> : null}
        </Section>

        {/* Product / service */}
        {(lead.productName || (lead.serviceInterest?.length) || lead.serviceOther || lead.productsInterested?.length) ? (
          <Section title="Product Interest">
            {lead.productName ? <KeyValue label="Product" value={lead.productName} /> : null}
            {lead.serviceInterest?.length ? <KeyValue label="Services" value={lead.serviceInterest.join(', ')} /> : null}
            {lead.serviceOther ? <KeyValue label="Other" value={lead.serviceOther} /> : null}
          </Section>
        ) : null}

        {/* Vehicles */}
        <Section title={`Vehicle${vehicles.length === 1 ? '' : 's'} (${vehicles.length})`} empty={vehicles.length === 0}>
          {vehicles.map((v, i) => (
            <View key={v.id || i}>
              {i > 0 ? <Divider spacer={spacing.sm} /> : null}
              <Txt variant="body" weight="semibold">{v.registration || (v.registrationKnown === false ? 'Unregistered' : v.chassisNo || '—')}</Txt>
              <Txt variant="faint">{[v.make, v.model, v.year].filter(Boolean).join(' · ') || '—'}</Txt>
              <View style={{ marginTop: 4 }}>
                {v.color ? <KeyValue label="Colour" value={v.color} /> : null}
                {v.chassisNo ? <KeyValue label="Chassis / VIN" value={v.chassisNo} /> : null}
                {v.engineNo ? <KeyValue label="Engine" value={v.engineNo} /> : null}
                {v.loanTermMonths ? <KeyValue label="Loan term" value={`${v.loanTermMonths} months`} /> : null}
              </View>
            </View>
          ))}
        </Section>

        {/* Installation */}
        {(lead.installationContactName || lead.installationCounty || lead.locationName) ? (
          <Section title="Installation">
            {lead.locationName ? <KeyValue label="Location / yard" value={lead.locationName} /> : null}
            <KeyValue label="County" value={lead.installationCounty} />
            <KeyValue label="Contact" value={lead.installationContactName} />
            <KeyValue label="Contact phone" value={lead.installationContactPhone} />
            {lead.locationDescription ? <KeyValue label="Description" value={lead.locationDescription} /> : null}
          </Section>
        ) : null}

        {/* Linked records */}
        {(lead.installationTicketNo || lead.invoiceNumber) ? (
          <Section title="Linked Records">
            {lead.installationTicketNo ? <KeyValue label="Install ticket" value={`${lead.installationTicketNo}${lead.installationTicketStatus ? ' · ' + lead.installationTicketStatus : ''}`} /> : null}
            {lead.invoiceNumber ? <KeyValue label="Invoice" value={`${lead.invoiceNumber}${lead.invoiceStatus ? ' · ' + lead.invoiceStatus : ''}`} /> : null}
          </Section>
        ) : null}

        {/* Quotation */}
        {!isCorporate ? (
          <Section title="Quotation">
            {lead.quoteId ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                  <Pill label="Raised" fg={colors.green} bg={colors.greenDim} />
                </View>
                <Txt variant="muted">
                  A quotation has been {isPrivateLead ? 'created' : 'auto-generated from the partner agreement'} for this lead
                  {lead.partnerName ? ` — ${lead.partnerName}` : isPrivateLead ? ' — Private / Individual' : ''}.
                </Txt>
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                  <NeonButton label="View Quote" icon="document-text-outline" full={false} style={{ flex: 1 }}
                    onPress={() => router.push(`/(app)/quotations/${lead.quoteId}`)} />
                  <NeonButton label="Edit Quote" icon="create-outline" variant="ghost" full={false} style={{ flex: 1 }}
                    onPress={() => router.push(`/(app)/quotations/${lead.quoteId}?edit=1`)} />
                </View>
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                  <Pill label="Not raised" />
                </View>
                <Txt variant="muted">
                  No quotation has been raised for this lead yet{isPrivateLead ? ' — this is a private / non-partner lead, so it isn\'t auto-quoted. Raise it, then edit the pricing.' : '.'}
                </Txt>
                {canRaiseQuote ? (
                  <>
                    <NeonButton label="Raise & Edit Quote" icon="add-circle-outline" loading={raising} onPress={raiseQuote} style={{ marginTop: spacing.md }} />
                    <Txt variant="faint" style={{ marginTop: spacing.sm }}>You can raise the quote now and set the pricing — it doesn't wait for the installation to be completed.</Txt>
                  </>
                ) : (
                  <Txt variant="faint" style={{ marginTop: spacing.sm }}>Submit the lead and create its installation ticket before a quote can be raised.</Txt>
                )}
              </>
            )}
          </Section>
        ) : null}

        {/* Attribution */}
        <Section title="Details">
          <KeyValue label="Sales rep" value={lead.salesRepName || lead.salesRepEmail} />
          {lead.bdmName ? <KeyValue label="BDM" value={lead.bdmName} /> : null}
          <KeyValue label="Created" value={fmtDate(lead.createdAt, true)} />
          {lead.submittedAt ? <KeyValue label="Submitted" value={fmtDate(lead.submittedAt, true)} /> : null}
        </Section>

        {canSubmit ? (
          <Section title="Before You Submit">
            <Field label="Location / partner yard name" required placeholder="e.g. Equity Bank Westlands"
              value={locationName} onChangeText={setLocationName} />
            <Field label="Instructions / notes for technician" placeholder="Access instructions…" value={locationNotes}
              onChangeText={setLocationNotes} multiline numberOfLines={2} style={{ minHeight: 60, textAlignVertical: 'top' }} />
            <NeonButton label="Submit lead & create ticket" icon="checkmark-done-outline" loading={submitting} onPress={submit} />
          </Section>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children, empty }: { title: string; children?: React.ReactNode; empty?: boolean }) {
  return (
    <GlassCard>
      <Txt variant="label" style={{ marginBottom: spacing.sm }}>{title}</Txt>
      {empty ? <Txt variant="faint">None on record.</Txt> : children}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  chips: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
});
