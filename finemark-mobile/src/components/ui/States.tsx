import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '@/theme';
import { Txt } from './Text';
import { NeonButton } from './NeonButton';

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.cyan} size="large" />
      {label ? <Txt variant="muted" style={{ marginTop: spacing.md }}>{label}</Txt> : null}
    </View>
  );
}

export function EmptyState({
  icon = 'file-tray-outline',
  title,
  subtitle,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={40} color={colors.textFaint} />
      <Txt variant="heading" style={{ marginTop: spacing.md }} center>
        {title}
      </Txt>
      {subtitle ? (
        <Txt variant="muted" center style={{ marginTop: 4 }}>
          {subtitle}
        </Txt>
      ) : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <Ionicons name="warning-outline" size={40} color={colors.red} />
      <Txt variant="body" center style={{ marginTop: spacing.md, color: colors.red }}>
        {message}
      </Txt>
      {onRetry ? (
        <NeonButton label="Retry" variant="ghost" full={false} onPress={onRetry} style={{ marginTop: spacing.lg }} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, minHeight: 200 },
});
