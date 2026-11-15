import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard, Txt, Pill, StatusRing } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { colors, spacing } from '@/theme';
import type { Ticket } from './api';

// stage → % (STEP_CONFIG has ~8 stages to Completed)
function stageProgress(t: Ticket): number {
  const s = (t.status || '').toLowerCase();
  if (s.includes('completed') || s.includes('closed')) return 100;
  const stage = typeof t.stage === 'number' ? t.stage : 0;
  return Math.min(95, Math.round((stage / 8) * 100));
}

export function JobCard({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  const reg = ticket.vehicleRegistration || 'No reg';
  const progress = stageProgress(ticket);
  const held = ticket.statusReason && ['On Hold', 'Rescheduled'].includes(ticket.status || '');

  return (
    <GlassCard onPress={onPress} neon={(ticket.status || '').toLowerCase().includes('inprogress')}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Txt variant="mono" weight="bold" color={colors.cyan}>
            {ticket.ticketNo || ticket.id?.slice(0, 8)}
          </Txt>
          <Txt variant="heading" style={{ marginTop: 2 }} numberOfLines={1}>
            {reg}
          </Txt>
          <Txt variant="muted" numberOfLines={1}>
            {ticket.customerName || '—'}
          </Txt>
          <View style={styles.metaRow}>
            <Pill label={ticket.status || 'Pending'} />
            {ticket.createdAt ? <Txt variant="faint">{fmtRelative(ticket.createdAt)}</Txt> : null}
          </View>
          {held ? (
            <View style={styles.holdRow}>
              <Ionicons name="pause-circle-outline" size={14} color={colors.amber} />
              <Txt variant="faint" style={{ color: colors.amber, flex: 1, marginLeft: 4 }} numberOfLines={1}>
                {ticket.statusReason}
              </Txt>
            </View>
          ) : null}
        </View>
        <StatusRing progress={progress} size={54} />
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  holdRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
});
