import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

import { Screen, NeonButton, Txt } from '@/components/ui';
import { useAuth } from '@/features/auth/authStore';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function UnlockScreen() {
  const user = useAuth((s) => s.user);
  const label = useAuth((s) => s.biometricLabel);
  const unlock = useAuth((s) => s.unlockWithBiometric);
  const useDifferentAccount = useAuth((s) => s.useDifferentAccount);
  const [busy, setBusy] = useState(false);

  const attempt = async () => {
    if (busy) return;
    setBusy(true);
    await unlock();
    setBusy(false);
  };

  // Auto-prompt biometric on mount for a one-tap return.
  useEffect(() => {
    attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bioIcon = label.toLowerCase().includes('face') ? 'scan-outline' : 'finger-print-outline';
  const firstName = (user?.name || user?.email || '').split(/[ @]/)[0];

  return (
    <Screen padded>
      <View style={styles.center}>
        <LinearGradient colors={neonGradient} style={styles.orb} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          <Ionicons name={bioIcon as any} size={44} color={colors.white} />
        </LinearGradient>
        <Txt variant="title" center style={{ marginTop: spacing.xl }}>
          Welcome back{firstName ? `, ${firstName}` : ''}
        </Txt>
        <Txt variant="muted" center style={{ marginTop: 4 }}>
          Unlock with {label} to continue
        </Txt>

        <NeonButton
          label={`Unlock with ${label}`}
          icon={bioIcon as any}
          loading={busy}
          onPress={attempt}
          style={{ marginTop: spacing.xxl }}
          full={false}
        />

        <Pressable style={styles.link} onPress={useDifferentAccount} disabled={busy}>
          <Txt variant="muted" style={{ color: colors.cyan }}>
            Use a different account
          </Txt>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  orb: {
    width: 96,
    height: 96,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.violet,
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  link: { marginTop: spacing.xl, padding: spacing.md },
});
