import React from 'react';
import { ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { colors, font, radius, spacing } from '@/theme';

export interface Segment {
  key: string;
  label: string;
  count?: number;
}

export function SegmentedTabs({
  segments,
  active,
  onChange,
}: {
  segments: Segment[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {segments.map((s) => {
        const on = s.key === active;
        return (
          <Pressable key={s.key} onPress={() => onChange(s.key)} style={[styles.tab, on && styles.tabOn]}>
            <Text style={[styles.label, on && styles.labelOn]}>
              {s.label}
              {typeof s.count === 'number' ? `  ${s.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingVertical: spacing.sm, paddingRight: spacing.lg },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
  },
  tabOn: { backgroundColor: colors.cyanDim, borderColor: colors.glassBorderNeon },
  label: { fontSize: font.size.sm, color: colors.textMuted, fontWeight: font.weight.medium as any },
  labelOn: { color: colors.cyan, fontWeight: font.weight.semibold as any },
});
