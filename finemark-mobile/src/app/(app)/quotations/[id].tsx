import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Pressable, ScrollView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';

import { Screen, GlassCard, Txt, Pill, KeyValue, Divider, NeonButton, Field, Sheet, Loading, ErrorState, toast } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';
import { shareQuotePdf, viewQuotePdf } from '@/features/sales/shareQuote';
import { fmtKES, fmtDate } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';
import { useAuth } from '@/features/auth/authStore';

// Mirrors backend crm-quotes.ts's QUOTE_EDIT_OVERRIDE_ROLES / partnerQuoteLocked():
// a quote with a real partner/bank agreement has its pricing locked to Sales — only
// Admin/Finance may edit it. Deliberately checks the RAW role (not effectiveRole),
// same as the backend check itself and web's crm-quote-detail.html.
const QUOTE_EDIT_OVERRIDE_ROLES = ['Admin', 'Finance'];

export default function QuotationDetail() {
  const { id, edit: editParam } = useLocalSearchParams<{ id: string; edit?: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const myRole = user?.role || '';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['quote', id],
    queryFn: () => SalesApi.quote(id!),
    enabled: !!id,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // edit fields
  const [ic, setIc] = useState('');
  const [sf, setSf] = useState('');
  const [tr, setTr] = useState('');
  const [da, setDa] = useState('');
  const [notes, setNotes] = useState('');
  const [expiry, setExpiry] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  // Working copy of line items while the edit sheet is open. Kept separate from
  // the read-only `items` list below so an unsaved edit doesn't affect the
  // summary view. PATCH /:id replaces ALL items on save, so every field the
  // backend stores (productId, stockItemId(s), discountPct) must be carried
  // through unchanged for fields the sheet doesn't expose, or they'd be
  // silently wiped even when the user only touched the name/description.
  const [editItems, setEditItems] = useState<any[]>([]);

  // Deep-link support for "Edit Quote" coming from the retail lead detail screen
  // (?edit=1) — mirrors web's raise-quote flow, which redirects straight into
  // crm-quote-edit.html. One-shot: only auto-opens once per screen visit.
  const autoEditConsumed = useRef(false);
  useEffect(() => {
    if (editParam !== '1' || autoEditConsumed.current || !data?.data) return;
    autoEditConsumed.current = true;
    const quote = data.data as any;
    const statusEditableNow = ['Draft', 'Sent'].includes(quote.status);
    const partnerLockedNow = !!quote.partnerId && !QUOTE_EDIT_OVERRIDE_ROLES.includes(myRole);
    if (!statusEditableNow) { toast.error('Only Draft/Sent quotes can be edited.'); return; }
    if (partnerLockedNow) { toast.error('Partner-priced quotation — pricing is locked to Admin/Finance.'); return; }
    const num2 = (v: any) => (v === null || v === undefined ? '' : String(v));
    setIc(num2(quote.installationCost)); setSf(num2(quote.subscriptionFee)); setTr(num2(quote.taxRate));
    setDa(num2(quote.discountAmount)); setNotes(quote.notes || '');
    setEditItems((quote.items || []).map((it: any) => ({ ...it })));
    setExpiry(quote.expiryDate ? new Date(quote.expiryDate) : null);
    setEditOpen(true);
  }, [editParam, data, myRole]);

  if (isLoading) return <Screen><Loading label="Loading quotation…" /></Screen>;
  if (isError) return <Screen><ErrorState message={(error as any)?.message || 'Could not load quotation'} onRetry={refetch} /></Screen>;

  const q: any = data?.data ?? {};
  const items: any[] = q.items ?? [];
  const veh = [q.vehicleRegistration, q.vehicleMake, q.vehicleModel].filter(Boolean).join(' · ');
  const statusEditable = ['Draft', 'Sent'].includes(q.status);
  // Same rule the server enforces (partnerQuoteLocked in crm-quotes.ts): a quote tied
  // to a real partner/bank agreement is locked to everyone except Admin/Finance, even
  // while it's otherwise in an editable status. Catching this client-side avoids a
  // surprise 403 the moment the rep hits Save.
  const partnerLocked = !!q.partnerId && !QUOTE_EDIT_OVERRIDE_ROLES.includes(myRole);
  const editable = statusEditable && !partnerLocked;
  const num = (v: any) => (v === null || v === undefined ? '' : String(v));
  // Mirrors crm-quote-detail.html: on a VAT-inclusive quote the tax RATE alone is
  // misleading (the total is gross, not net-plus-tax) — show the embedded VAT instead.
  const taxDisplay = q.vatInclusive
    ? (() => {
        const gross = Number(q.totalAmount || 0);
        const net = Math.round((gross / 1.16) * 100) / 100;
        const vat = Math.round((gross - net) * 100) / 100;
        return `16% incl. (${fmtKES(vat)} of ${fmtKES(net)} net)`;
      })()
    : `${q.taxRate ?? 0}%`;

  const openEdit = () => {
    if (!statusEditable) return toast.error('Only Draft/Sent quotes can be edited.');
    if (partnerLocked) return toast.error('Partner-priced quotation — pricing is locked to Admin/Finance.');
    setIc(num(q.installationCost)); setSf(num(q.subscriptionFee)); setTr(num(q.taxRate));
    setDa(num(q.discountAmount)); setNotes(q.notes || '');
    setExpiry(q.expiryDate ? new Date(q.expiryDate) : null);
    setEditItems(items.map((it: any) => ({ ...it })));
    setEditOpen(true);
  };

  const updateEditItem = (idx: number, field: string, value: string) => {
    setEditItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  };
  const removeEditItem = (idx: number) => setEditItems((prev) => prev.filter((_, i) => i !== idx));
  const addEditItem = () => setEditItems((prev) => [...prev, { deviceModel: '', description: '', quantity: '1', unitPrice: '0' }]);

  const saveEdit = async () => {
    if (editItems.some((it) => !String(it.deviceModel || '').trim())) {
      return toast.error('Every line item needs a product / service name.');
    }
    setBusy(true);
    try {
      await SalesApi.updateQuote(id!, {
        installationCost: parseFloat(ic) || 0,
        subscriptionFee: parseFloat(sf) || 0,
        taxRate: parseFloat(tr) || 0,
        discountAmount: parseFloat(da) || 0,
        notes: notes.trim() || null,
        expiryDate: expiry ? expiry.toISOString().slice(0, 10) : null,
        // Full replace — carry through fields the sheet doesn't expose
        // (productId/stockItemId(s)/discountPct) unchanged so device/serial
        // links already on the quote aren't silently dropped.
        items: editItems.map((it) => ({
          ...it,
          deviceModel: String(it.deviceModel || '').trim(),
          description: String(it.description || '').trim() || null,
          quantity: parseInt(it.quantity, 10) || 1,
          unitPrice: parseFloat(it.unitPrice) || 0,
        })),
      });
      toast.success('Quotation updated');
      setEditOpen(false);
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not update');
    } finally { setBusy(false); }
  };

  const sendEmail = async () => {
    if (!emailTo.trim()) return toast.error('Enter an email address');
    setBusy(true);
    try {
      await SalesApi.sendQuote(id!, emailTo.trim());
      toast.success(`Quotation sent to ${emailTo.trim()}`);
      setEmailOpen(false);
      qc.invalidateQueries({ queryKey: ['quote', id] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not send');
    } finally { setBusy(false); }
  };

  const shareWhatsApp = () => {
    const phone = String(q.customerPhone || '').replace(/\D/g, '');
    const msg = `Hi ${q.customerName || ''}, please find your quotation ${q.quoteNo || ''}.\nTotal: ${fmtKES(q.totalAmount)}.\nKindly review and confirm. Thank you.`;
    // Shares the actual PDF via the OS share sheet (pick WhatsApp); falls back to a
    // WhatsApp text message on older builds without the expo-sharing native module.
    // A successful share (either path) optimistically transitions Draft → Sent, same
    // as web's WhatsApp-share button.
    shareQuotePdf(id!, q.quoteNo || '', { phone, text: msg }, {
      currentStatus: q.status,
      onMarkedSent: () => {
        qc.invalidateQueries({ queryKey: ['quote', id] });
        qc.invalidateQueries({ queryKey: ['quotes'] });
      },
    });
  };

  const markSent = async () => {
    setActionBusy(true);
    try {
      await SalesApi.markQuoteSent(id!);
      toast.success('Quotation marked as Sent');
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not mark as sent');
    } finally { setActionBusy(false); }
  };

  const acceptQuote = async () => {
    setActionBusy(true);
    try {
      await SalesApi.acceptQuote(id!);
      toast.success('Quotation accepted');
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not accept quotation');
    } finally { setActionBusy(false); }
  };

  const submitReject = async () => {
    setActionBusy(true);
    try {
      await SalesApi.rejectQuote(id!, rejectReason.trim() || undefined);
      toast.success('Quotation rejected');
      setRejectOpen(false);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
      refetch();
    } catch (e) {
      toast.error((e as ApiError)?.message || 'Could not reject quotation');
    } finally { setActionBusy(false); }
  };

  return (
    <Screen padded={false}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Ionicons name="chevron-back" size={24} color={colors.text} /></Pressable>
        <Txt variant="mono" weight="bold" color={colors.cyan}>{q.quoteNo || String(id).slice(0, 8)}</Txt>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 140, gap: spacing.md }} showsVerticalScrollIndicator={false}>
        <GlassCard neon>
          <Txt variant="title" numberOfLines={2}>{q.customerName || 'Customer'}</Txt>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill label={q.status || 'Draft'} />
            {q.revisionNo ? <Txt variant="faint">Rev {q.revisionNo}</Txt> : null}
          </View>
          <Divider />
          <View style={styles.totalRow}>
            <Txt variant="label">Total</Txt>
            <Txt variant="mono" weight="bold" style={{ fontSize: 26, color: colors.cyan }}>{fmtKES(q.totalAmount)}</Txt>
          </View>
        </GlassCard>

        {/* pricingMissing/vatInclusive flags — both real crm_quotes columns for
            partner/bank-financed auto-generated quotes; see web's crm-quote-detail.html. */}
        {q.pricingMissing ? (
          <View style={[styles.banner, { borderColor: colors.amber + '55', backgroundColor: colors.amberDim }]}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.amber} />
            <Txt variant="muted" style={{ color: colors.amber, flex: 1, marginLeft: spacing.sm }}>
              Pricing pending — line items are at KES 0 until partner pricing is resolved.
            </Txt>
          </View>
        ) : null}
        {q.vatInclusive ? (
          <View style={[styles.banner, { borderColor: colors.cyan + '55', backgroundColor: colors.cyanDim }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.cyan} />
            <Txt variant="muted" style={{ color: colors.cyan, flex: 1, marginLeft: spacing.sm }}>
              VAT-inclusive quote — the total above already includes VAT.
            </Txt>
          </View>
        ) : null}

        {/* Actions */}
        <View style={styles.actionsRow}>
          <ActionBtn icon="create-outline" label="Edit" tint={editable ? colors.cyan : colors.textFaint} onPress={openEdit} />
          <ActionBtn icon="document-text-outline" label="View PDF" tint={colors.cyan}
            onPress={() => viewQuotePdf(id!, q.quoteNo || '')} />
          <ActionBtn icon="logo-whatsapp" label="WhatsApp" tint={colors.green} onPress={shareWhatsApp} />
          <ActionBtn icon="mail-outline" label="Email" tint={colors.violet} onPress={() => { setEmailTo(q.customerEmail && q.customerEmail !== '—' ? q.customerEmail : ''); setEmailOpen(true); }} />
        </View>
        {partnerLocked && statusEditable ? (
          <View style={styles.lockNotice}>
            <Ionicons name="lock-closed-outline" size={14} color={colors.textFaint} />
            <Txt variant="faint" style={{ marginLeft: spacing.sm }}>Partner-priced quotation — pricing is locked to Admin/Finance.</Txt>
          </View>
        ) : null}

        {/* Lifecycle actions — mirrors web's status-gated buttons (Sent → Accept/Reject;
            Draft → Send to Customer without email). BDM-approve/Revise/Convert-to-proforma
            are intentionally out of scope for this pass. */}
        {q.status === 'Draft' || q.status === 'Sent' ? (
          <View style={styles.actionsRow}>
            {q.status === 'Draft' ? (
              <ActionBtn icon="paper-plane-outline" label="Mark Sent" tint={colors.cyan} onPress={markSent} disabled={actionBusy} />
            ) : null}
            {q.status === 'Sent' ? (
              <>
                <ActionBtn icon="checkmark-circle-outline" label="Accept" tint={colors.green} onPress={acceptQuote} disabled={actionBusy} />
                <ActionBtn icon="close-circle-outline" label="Reject" tint={colors.red} onPress={() => setRejectOpen(true)} disabled={actionBusy} />
              </>
            ) : null}
          </View>
        ) : null}

        <GlassCard>
          <Txt variant="label" style={{ marginBottom: spacing.sm }}>Line items ({items.length})</Txt>
          {items.length === 0 ? <Txt variant="faint">No line items.</Txt> : items.map((it, i) => (
            <View key={it.id || i}>
              {i > 0 ? <Divider spacer={spacing.sm} /> : null}
              <View style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Txt variant="body" numberOfLines={2}>{it.deviceModel || it.description || it.name || it.productName || 'Item'}</Txt>
                  <Txt variant="faint">{(it.quantity ?? it.qty ?? 1)} × {fmtKES(it.unitPrice ?? it.unit_price)}</Txt>
                </View>
                <Txt variant="mono" weight="semibold">{fmtKES(it.totalPrice ?? it.total_price ?? it.lineTotal)}</Txt>
              </View>
            </View>
          ))}
        </GlassCard>

        <GlassCard>
          <Txt variant="label" style={{ marginBottom: spacing.sm }}>Summary</Txt>
          {q.installationCost != null ? <KeyValue label="Installation cost" value={fmtKES(q.installationCost)} /> : null}
          {q.subscriptionFee != null ? <KeyValue label="Subscription fee" value={fmtKES(q.subscriptionFee)} /> : null}
          {q.taxRate != null ? <KeyValue label={q.vatInclusive ? 'VAT' : 'Tax rate'} value={taxDisplay} /> : null}
          {q.discountAmount ? <KeyValue label="Discount" value={fmtKES(q.discountAmount)} /> : null}
          <Divider spacer={spacing.sm} />
          <KeyValue label="Total" value={fmtKES(q.totalAmount)} />
        </GlassCard>

        <GlassCard>
          <Txt variant="label" style={{ marginBottom: spacing.sm }}>Details</Txt>
          {veh ? <KeyValue label="Vehicle" value={veh} /> : null}
          {q.partnerName ? <KeyValue label="Partner" value={q.partnerName} /> : null}
          {q.customerPhone && q.customerPhone !== '—' ? <KeyValue label="Phone" value={q.customerPhone} /> : null}
          {q.customerEmail && q.customerEmail !== '—' ? <KeyValue label="Email" value={q.customerEmail} /> : null}
          <KeyValue label="Sales rep" value={q.salesRepName || q.salesRepEmail} />
          {q.expiryDate ? <KeyValue label="Expires" value={fmtDate(q.expiryDate)} /> : null}
          <KeyValue label="Created" value={fmtDate(q.createdAt, true)} />
          {q.notes ? <KeyValue label="Notes" value={q.notes} /> : null}
        </GlassCard>
      </ScrollView>

      {/* Edit sheet */}
      <Sheet visible={editOpen} onClose={() => setEditOpen(false)} title="Edit quotation">
        <Txt variant="label" style={{ marginBottom: spacing.sm }}>Line items</Txt>
        {editItems.map((it, idx) => (
          <View key={it.id ?? idx} style={styles.itemEditCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Txt variant="faint">Item {idx + 1}</Txt>
              <Pressable onPress={() => removeEditItem(idx)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={colors.textFaint} />
              </Pressable>
            </View>
            <Field label="Product / custom service name" placeholder="e.g. Vehicle Tracker VT-200, or a custom service"
              value={it.deviceModel ?? ''} onChangeText={(v) => updateEditItem(idx, 'deviceModel', v)} />
            <Field label="Description" placeholder="Additional details shown on the quotation (optional)"
              value={it.description ?? ''} onChangeText={(v) => updateEditItem(idx, 'description', v)} />
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Field label="Qty" keyboardType="numeric" value={String(it.quantity ?? '1')} onChangeText={(v) => updateEditItem(idx, 'quantity', v)} />
              </View>
              <View style={{ flex: 2 }}>
                <Field label="Unit price (KES)" keyboardType="numeric" value={String(it.unitPrice ?? '0')} onChangeText={(v) => updateEditItem(idx, 'unitPrice', v)} />
              </View>
            </View>
          </View>
        ))}
        <Pressable onPress={addEditItem} style={styles.addItemBtn}>
          <Ionicons name="add-circle-outline" size={18} color={colors.cyan} />
          <Txt variant="body" style={{ color: colors.cyan, marginLeft: spacing.sm }}>Add product / custom item</Txt>
        </Pressable>
        <Divider spacer={spacing.md} />

        <Field label="Installation cost (KES)" keyboardType="numeric" value={ic} onChangeText={setIc} />
        <Field label="Subscription fee (KES)" keyboardType="numeric" value={sf} onChangeText={setSf} />
        <Field label="Tax rate (%)" keyboardType="numeric" value={tr} onChangeText={setTr} />
        <Field label="Discount (KES)" keyboardType="numeric" value={da} onChangeText={setDa} />
        <Txt variant="label" style={{ marginBottom: spacing.sm }}>Expiry date</Txt>
        <Pressable style={styles.dateBtn} onPress={() => setShowDate(true)}>
          <Ionicons name="calendar-outline" size={18} color={colors.cyan} />
          <Txt variant="body" style={{ marginLeft: spacing.sm }}>{expiry ? fmtDate(expiry.toISOString()) : 'Select date'}</Txt>
        </Pressable>
        {showDate ? (
          <DateTimePicker value={expiry || new Date()} mode="date"
            onChange={(_, d) => { setShowDate(Platform.OS === 'ios'); if (d) setExpiry(d); }} />
        ) : null}
        <Field label="Notes" value={notes} onChangeText={setNotes} multiline numberOfLines={3} style={{ minHeight: 76, textAlignVertical: 'top' }} />
        <Txt variant="faint" style={{ marginBottom: spacing.sm }}>Total recalculates automatically from these figures.</Txt>
        <NeonButton label="Save changes" icon="save-outline" loading={busy} onPress={saveEdit} />
      </Sheet>

      {/* Email sheet */}
      <Sheet visible={emailOpen} onClose={() => setEmailOpen(false)} title="Email quotation">
        <Txt variant="muted" style={{ marginBottom: spacing.md }}>Sends the quotation PDF to the customer and marks it as Sent.</Txt>
        <Field label="Send to" placeholder="customer@example.com" autoCapitalize="none" keyboardType="email-address" value={emailTo} onChangeText={setEmailTo} required />
        <NeonButton label="Send email" icon="paper-plane-outline" loading={busy} onPress={sendEmail} />
      </Sheet>

      {/* Reject sheet — reason is optional server-side (crm-quotes.ts stores whatever
          is sent, including null) but we still prompt for one, matching web's reject modal. */}
      <Sheet visible={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject quotation">
        <Field label="Reason" placeholder="Reason for rejection…" value={rejectReason} onChangeText={setRejectReason} multiline numberOfLines={3} style={{ minHeight: 76, textAlignVertical: 'top' }} />
        <NeonButton label="Reject quotation" icon="close-circle-outline" variant="danger" loading={actionBusy} onPress={submitReject} />
      </Sheet>
    </Screen>
  );
}

function ActionBtn({ icon, label, tint, onPress, disabled }: { icon: keyof typeof Ionicons.glyphMap; label: string; tint: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.actionBtn, { borderColor: tint + '55' }, disabled && styles.actionBtnDisabled]} onPress={onPress} disabled={disabled}>
      <Ionicons name={icon} size={20} color={tint} />
      <Txt variant="muted" style={{ color: tint, marginTop: 4 }}>{label}</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  actionsRow: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: {
    flex: 1, alignItems: 'center', paddingVertical: spacing.md, borderRadius: radius.md,
    borderWidth: 1, backgroundColor: colors.glass,
  },
  actionBtnDisabled: { opacity: 0.5 },
  banner: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.md, borderWidth: 1,
  },
  lockNotice: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs },
  dateBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md,
  },
  itemEditCard: {
    backgroundColor: colors.glassStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder,
    borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm,
  },
  addItemBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, marginBottom: spacing.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder, borderRadius: radius.md, borderStyle: 'dashed',
  },
});
