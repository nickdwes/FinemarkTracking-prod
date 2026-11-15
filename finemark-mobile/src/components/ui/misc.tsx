import React from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, radius } from '@/theme';
import { Txt } from './Text';

export function Divider({ spacer = spacing.md }: { spacer?: number }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, marginVertical: spacer }} />;
}

/** Label/value row used across detail screens. */
export function KeyValue({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <View style={styles.kv}>
      <Txt variant="muted" style={styles.kvLabel}>
        {label}
      </Txt>
      <Txt variant={mono ? 'mono' : 'body'} style={[styles.kvValue, empty && { color: colors.textFaint, fontStyle: 'italic' }]}>
        {empty ? '—' : String(value)}
      </Txt>
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Txt variant="label">{title}</Txt>
      {action}
    </View>
  );
}

/** Small icon chip button (e.g. call, navigate). */
export function IconChip({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label?: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}>
      <Ionicons name={icon} size={16} color={colors.cyan} />
      {label ? (
        <Txt variant="muted" style={{ color: colors.cyan, marginLeft: 6 }}>
          {label}
        </Txt>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 6, gap: spacing.lg },
  kvLabel: { flexShrink: 0, maxWidth: '45%' },
  kvValue: { flex: 1, textAlign: 'right' },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cyanDim,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
});
