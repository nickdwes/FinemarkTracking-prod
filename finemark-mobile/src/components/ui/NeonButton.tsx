import React from 'react';
import { Pressable, Text, StyleSheet, ActivityIndicator, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, neonGradient, radius, spacing } from '@/theme';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

interface NeonButtonProps {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: ViewStyle;
  full?: boolean;
}

export function NeonButton({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  icon,
  style,
  full = true,
}: NeonButtonProps) {
  const isDisabled = disabled || loading;
  const content = (
    <View style={styles.row}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.white : colors.cyan} size="small" />
      ) : (
        <>
          {icon ? (
            <Ionicons
              name={icon}
              size={18}
              color={variant === 'primary' ? colors.white : variant === 'danger' ? colors.red : colors.cyan}
              style={{ marginRight: spacing.sm }}
            />
          ) : null}
          <Text style={[styles.label, variantLabel(variant)]}>{label}</Text>
        </>
      )}
    </View>
  );

  if (variant === 'primary') {
    return (
      <Pressable onPress={onPress} disabled={isDisabled} style={({ pressed }) => [full && styles.full, pressed && styles.pressed, isDisabled && styles.dim, style]}>
        <LinearGradient colors={neonGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.base}>
          {content}
        </LinearGradient>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [styles.base, variantBox(variant), full && styles.full, pressed && styles.pressed, isDisabled && styles.dim, style]}
    >
      {content}
    </Pressable>
  );
}

function variantBox(v: Variant): ViewStyle {
  switch (v) {
    case 'danger':
      return { backgroundColor: colors.redDim, borderWidth: 1, borderColor: colors.red };
    case 'subtle':
      return { backgroundColor: colors.glassStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder };
    default:
      return { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassBorderNeon };
  }
}
function variantLabel(v: Variant) {
  if (v === 'primary') return { color: colors.white };
  if (v === 'danger') return { color: colors.red };
  return { color: colors.cyan };
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: font.size.md, fontWeight: font.weight.semibold as any },
  pressed: { opacity: 0.85 },
  dim: { opacity: 0.5 },
});
