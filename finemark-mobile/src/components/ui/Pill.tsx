import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { font, radius, statusColors } from '@/theme';

/** Status pill; colors auto-derived from the status string (or pass explicit fg/bg). */
export function Pill({ label, fg, bg }: { label: string; fg?: string; bg?: string }) {
  const c = fg && bg ? { fg, bg } : statusColors(label);
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <View style={[styles.dot, { backgroundColor: c.fg }]} />
      <Text style={[styles.text, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  text: { fontSize: font.size.xs, fontWeight: font.weight.semibold as any },
});
