import React from 'react';
import { View, TextInput, StyleSheet, Text, type TextInputProps } from 'react-native';
import { colors, font, radius, spacing } from '@/theme';

interface FieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
}

export function Field({ label, error, hint, required, style, ...rest }: FieldProps) {
  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={styles.label}>
          {label}
          {required ? <Text style={{ color: colors.cyan }}> *</Text> : null}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        style={[styles.input, !!error && styles.inputError, style]}
        {...rest}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold as any,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: font.size.md,
  },
  inputError: { borderColor: colors.red, borderWidth: 1 },
  error: { color: colors.red, fontSize: font.size.xs, marginTop: 4 },
  hint: { color: colors.textFaint, fontSize: font.size.xs, marginTop: 4 },
});
