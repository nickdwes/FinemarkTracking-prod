import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Screen, GlassCard, Txt } from '@/components/ui';
import { useAuth } from '@/features/auth/authStore';
import { baseRole, ROLES } from '@/constants/roles';
import { REPORTS, openReport } from '@/lib/reportBridge';
import { colors, spacing, radius } from '@/theme';

export default function ReportsScreen() {
  const user = useAuth((s) => s.user);
  const role = baseRole(user);
  const isAdmin = role === ROLES.ADMIN;
  const visible = REPORTS.filter((r) => !r.roles || isAdmin || r.roles.includes(role));

  return (
    <Screen scroll>
      <Txt variant="title" style={{ marginTop: spacing.md }}>
        Reports
      </Txt>
      <Txt variant="muted" style={{ marginBottom: spacing.md }}>
        Full dashboards open securely in the web portal.
      </Txt>

      <View style={{ gap: spacing.md }}>
        {visible.map((r) => (
          <GlassCard key={r.key} onPress={() => openReport(r.page)}>
            <View style={styles.row}>
              <View style={styles.icon}>
                <Ionicons name={r.icon as any} size={22} color={colors.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Txt variant="heading">{r.title}</Txt>
                <Txt variant="muted">{r.subtitle}</Txt>
              </View>
              <Ionicons name="open-outline" size={18} color={colors.textFaint} />
            </View>
          </GlassCard>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.cyanDim, alignItems: 'center', justifyContent: 'center' },
});
