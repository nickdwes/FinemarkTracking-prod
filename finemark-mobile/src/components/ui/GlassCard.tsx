import React from 'react';
import { View, StyleSheet, Pressable, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { colors, radius, spacing } from '@/theme';

interface GlassCardProps {
  children: React.ReactNode;
  onPress?: () => void;
  neon?: boolean; // cyan-tinted border + subtle glow
  style?: ViewStyle;
  padded?: boolean;
}

/** Frosted-glass surface: blurred translucent panel with a faint neon-capable border. */
export function GlassCard({ children, onPress, neon = false, style, padded = true }: GlassCardProps) {
  const inner = (
    <BlurView intensity={24} tint="dark" style={[styles.blur, neon && styles.neonBorder, style]}>
      <View style={[styles.overlay, padded && styles.padded]}>{children}</View>
    </BlurView>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.wrap, neon && styles.glow, pressed && styles.pressed]}>
        {inner}
      </Pressable>
    );
  }
  return <View style={[styles.wrap, neon && styles.glow]}>{inner}</View>;
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.lg, overflow: 'hidden' },
  glow: {
    shadowColor: colors.cyan,
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  blur: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
  },
  neonBorder: { borderColor: colors.glassBorderNeon, borderWidth: 1 },
  overlay: { backgroundColor: colors.glass },
  padded: { padding: spacing.lg },
});
