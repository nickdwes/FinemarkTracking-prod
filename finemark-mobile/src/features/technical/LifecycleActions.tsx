import React, { useState } from 'react';
import { View, StyleSheet, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';

import { Sheet, NeonButton, Field, Txt, toast } from '@/components/ui';
import { TechApi, type Ticket } from './api';
import { useTicketMutation } from './hooks';
import { fmtDate } from '@/lib/format';
import { Evidence, EvidencePicker } from './EvidencePicker';
import { colors, radius, spacing } from '@/theme';

type Action = 'hold' | 'reschedule' | 'cancel' | 'default' | 'resume';

const LC: Record<Action, { label: string; icon: keyof typeof Ionicons.glyphMap; tint: string; needsEvidence: boolean; needsDate: boolean; title: string }> = {
  hold: { label: 'Pause', icon: 'pause-outline', tint: colors.amber, needsEvidence: false, needsDate: false, title: 'Pause job' },
  reschedule: { label: 'Reschedule', icon: 'calendar-outline', tint: colors.amber, needsEvidence: false, needsDate: true, title: 'Reschedule job' },
  cancel: { label: 'Cancel', icon: 'close-circle-outline', tint: colors.red, needsEvidence: true, needsDate: false, title: 'Cancel job' },
  default: { label: 'Defaulted', icon: 'warning-outline', tint: colors.red, needsEvidence: true, needsDate: false, title: 'Mark as defaulted' },
  resume: { label: 'Resume', icon: 'play-outline', tint: colors.green, needsEvidence: false, needsDate: false, title: 'Resume job' },
};

const TERMINAL = ['Completed', 'Closed', 'Cancelled', 'Defaulted'];

export function LifecycleActions({ ticket, onDone }: { ticket: Ticket; onDone: () => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [date, setDate] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);

  const status = ticket.status || '';
  const isPaused = ['On Hold', 'Rescheduled'].includes(status);
  const isTerminal = TERMINAL.includes(status);

  const mutation = useTicketMutation(
    (body: any) => TechApi.lifecycle(ticket.id, body),
    { ticketId: ticket.id, onDone: () => { close(); onDone(); } },
  );

  const open = (a: Action) => {
    setAction(a);
    setReason('');
    setEvidence([]);
    setDate(null);
  };
  const close = () => setAction(null);

  const submit = () => {
    if (!action) return;
    const cfg = LC[action];
    if (action !== 'resume' && !reason.trim()) return toast.error('A reason is required');
    if (cfg.needsEvidence && evidence.length === 0) return toast.error('At least one evidence photo is required');
    if (cfg.needsDate && !date) return toast.error('Pick a new date');
    mutation.mutate({
      action,
      reason: reason.trim() || undefined,
      evidence: evidence.map((e) => ({ url: e.url, filename: e.filename })),
      rescheduledTo: date ? date.toISOString() : undefined,
    });
  };

  if (isTerminal) return null;

  return (
    <View>
      <Txt variant="label" style={{ marginBottom: spacing.sm }}>
        Job actions
      </Txt>
      <View style={styles.row}>
        {isPaused ? (
          <ActionBtn a="resume" onPress={() => open('resume')} />
        ) : (
          <>
            <ActionBtn a="hold" onPress={() => open('hold')} />
            <ActionBtn a="reschedule" onPress={() => open('reschedule')} />
          </>
        )}
        <ActionBtn a="cancel" onPress={() => open('cancel')} />
        <ActionBtn a="default" onPress={() => open('default')} />
      </View>

      <Sheet visible={!!action} onClose={close} title={action ? LC[action].title : ''}>
        {action === 'resume' ? (
          <Txt variant="muted" style={{ marginBottom: spacing.lg }}>
            This restores the job to its previous active state so work can continue.
          </Txt>
        ) : (
          <Field
            label="Reason"
            placeholder="Explain what happened…"
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={3}
            style={{ minHeight: 84, textAlignVertical: 'top' }}
            required
          />
        )}

        {action && LC[action].needsDate ? (
          <View style={{ marginBottom: spacing.md }}>
            <Txt variant="label" style={{ marginBottom: spacing.sm }}>
              New date
            </Txt>
            <Pressable style={styles.dateBtn} onPress={() => setShowDate(true)}>
              <Ionicons name="calendar-outline" size={18} color={colors.cyan} />
              <Txt variant="body" style={{ marginLeft: spacing.sm }}>
                {date ? fmtDate(date.toISOString()) : 'Select a date'}
              </Txt>
            </Pressable>
            {showDate ? (
              <DateTimePicker
                value={date || new Date()}
                mode="date"
                minimumDate={new Date()}
                onChange={(_, d) => {
                  setShowDate(Platform.OS === 'ios');
                  if (d) setDate(d);
                }}
              />
            ) : null}
          </View>
        ) : null}

        {action && LC[action].needsEvidence ? (
          <EvidencePicker ticketId={ticket.id} value={evidence} onChange={setEvidence} label="Supporting evidence (required)" />
        ) : null}

        <NeonButton
          label={action ? LC[action].label : ''}
          loading={mutation.isPending}
          onPress={submit}
          variant={action === 'cancel' || action === 'default' ? 'danger' : 'primary'}
          style={{ marginTop: spacing.md }}
        />
      </Sheet>
    </View>
  );
}

function ActionBtn({ a, onPress }: { a: Action; onPress: () => void }) {
  const cfg = LC[a];
  return (
    <Pressable style={[styles.actionBtn, { borderColor: cfg.tint + '66' }]} onPress={onPress}>
      <Ionicons name={cfg.icon} size={18} color={cfg.tint} />
      <Txt variant="muted" style={{ color: cfg.tint, marginTop: 4 }}>
        {cfg.label}
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actionBtn: {
    minWidth: 82,
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.glass,
  },
  dateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
