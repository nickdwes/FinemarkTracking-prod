import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Switch, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

import { Screen, GlassCard, Txt, NeonButton, Divider, KeyValue } from '@/components/ui';
import { useAuth } from '@/features/auth/authStore';
import { getBiometricCapability } from '@/features/auth/biometrics';
import { useIsOnline } from '@/lib/online';
import { initials } from '@/lib/format';
import { colors, neonGradient, radius, spacing } from '@/theme';

export default function MeScreen() {
  const user = useAuth((s) => s.user);
  const bioEnabled = useAuth((s) => s.biometricEnabled);
  const bioLabel = useAuth((s) => s.biometricLabel);
  const enableBiometric = useAuth((s) => s.enableBiometric);
  const signOut = useAuth((s) => s.signOut);
  const online = useIsOnline();
  const [bioAvailable, setBioAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBiometricCapability().then((c) => setBioAvailable(c.available && c.enrolled));
  }, []);

  return (
    <Screen scroll>
      <View style={styles.header}>
        <LinearGradient colors={neonGradient} style={styles.avatar} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          <Txt variant="title" color={colors.white}>
            {initials(user?.name || user?.email)}
          </Txt>
        </LinearGradient>
        <Txt variant="title" center style={{ marginTop: spacing.md }}>
          {user?.name || user?.email}
        </Txt>
        <Txt variant="muted" center>
          {user?.role}
        </Txt>
      </View>

      <GlassCard>
        <KeyValue label="Email" value={user?.email} />
        <Divider spacer={spacing.sm} />
        <KeyValue label="Employee No" value={user?.employeeNo || '—'} />
        <Divider spacer={spacing.sm} />
        <KeyValue label="Connection" value={online ? 'Online' : 'Offline'} />
      </GlassCard>

      {bioAvailable ? (
        <GlassCard style={{ marginTop: spacing.md }}>
          <View style={styles.switchRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <Ionicons name="finger-print-outline" size={22} color={colors.cyan} />
              <View style={{ marginLeft: spacing.md, flex: 1 }}>
                <Txt variant="body" weight="semibold">
                  {bioLabel} unlock
                </Txt>
                <Txt variant="faint">Unlock the app without a password</Txt>
              </View>
            </View>
            <Switch
              value={bioEnabled}
              onValueChange={(v) => enableBiometric(v)}
              trackColor={{ true: colors.cyan, false: colors.glassBorder }}
              thumbColor={colors.white}
            />
          </View>
        </GlassCard>
      ) : null}

      <Pressable style={styles.aboutRow}>
        <Txt variant="faint" center>
          Finemark Mobile v{Constants.expoConfig?.version ?? '1.0.0'}
        </Txt>
      </Pressable>

      <NeonButton
        label="Sign out"
        icon="log-out-outline"
        variant="danger"
        loading={busy}
        onPress={async () => {
          setBusy(true);
          await signOut();
          setBusy(false);
        }}
        style={{ marginTop: spacing.lg }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.xl },
  avatar: { width: 84, height: 84, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center' },
  aboutRow: { paddingVertical: spacing.xl },
});
