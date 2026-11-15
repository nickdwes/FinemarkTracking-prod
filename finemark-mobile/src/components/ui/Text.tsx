import React from 'react';
import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from 'react-native';
import { colors, font } from '@/theme';

type Variant = 'display' | 'title' | 'heading' | 'body' | 'muted' | 'faint' | 'label' | 'mono';

interface Props extends TextProps {
  variant?: Variant;
  color?: string;
  weight?: keyof typeof font.weight;
  center?: boolean;
}

export function Txt({ variant = 'body', color, weight, center, style, ...rest }: Props) {
  return (
    <RNText
      {...rest}
      style={[
        styles.base,
        variantStyle[variant],
        color ? { color } : null,
        weight ? { fontWeight: font.weight[weight] as any } : null,
        center ? { textAlign: 'center' } : null,
        style,
      ]}
    />
  );
}

const variantStyle: Record<Variant, TextStyle> = {
  display: { fontSize: font.size.display, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
  title: { fontSize: font.size.xxl, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  heading: { fontSize: font.size.lg, fontWeight: '600', color: colors.text },
  body: { fontSize: font.size.md, color: colors.text },
  muted: { fontSize: font.size.sm, color: colors.textMuted },
  faint: { fontSize: font.size.xs, color: colors.textFaint },
  label: { fontSize: font.size.xs, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  mono: { fontSize: font.size.md, color: colors.text, fontFamily: 'monospace' },
};

const styles = StyleSheet.create({ base: { color: colors.text } });
